// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ResourceToken} from "./ResourceToken.sol";
import {IDiggerResVmtMirror} from "./generated/DiggerResVmtMirror.sol";
import {IDiggerRedeemMirror} from "./generated/DiggerRedeemMirror.sol";

contract DiggerL1Adapter {
    enum OperationKind {
        None,
        Mint,
        Redeem
    }

    struct Operation {
        OperationKind kind;
        address user;
        uint128 scrst;
        uint128 bcrst;
        uint128 hcrst;
        uint256 payout;
    }

    uint256 public constant SCRST_RATE = 66 ether;
    uint256 public constant BCRST_RATE = 330 ether;
    uint256 public constant HCRST_RATE = 1650 ether;

    address public immutable owner;
    IDiggerResVmtMirror public immutable resVmtMirror;
    IDiggerRedeemMirror public immutable redeemMirror;

    ResourceToken public immutable scrst;
    ResourceToken public immutable bcrst;
    ResourceToken public immutable hcrst;

    uint256 public totalReservedPayout;
    mapping(address => uint256) public claimable;
    mapping(bytes32 => Operation) public pending;

    event MintRequested(bytes32 indexed messageId, address indexed user, uint128 scrst, uint128 bcrst, uint128 hcrst);
    event MintConfirmed(bytes32 indexed messageId, address indexed user, uint128 scrst, uint128 bcrst, uint128 hcrst);
    event RedeemRequested(
        bytes32 indexed messageId, address indexed user, uint128 scrst, uint128 bcrst, uint128 hcrst, uint256 payout
    );
    event RedeemConfirmed(bytes32 indexed messageId, address indexed user, uint256 payout);
    event OperationFailed(bytes32 indexed messageId, address indexed user, OperationKind kind, bytes reason);
    event ClaimWithdrawn(address indexed user, uint256 amount);

    error NotOwner();
    error NotMirror();
    error UnknownMessage();
    error WrongCallback();
    error ZeroOperation();
    error ZeroAddress();
    error DuplicateMessage();
    error InsufficientReserve();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address resVmtMirror_, address redeemMirror_) {
        if (resVmtMirror_ == address(0) || redeemMirror_ == address(0)) {
            revert ZeroAddress();
        }

        owner = msg.sender;
        resVmtMirror = IDiggerResVmtMirror(resVmtMirror_);
        redeemMirror = IDiggerRedeemMirror(redeemMirror_);

        scrst = new ResourceToken("Digger SCRST", "SCRST", address(this));
        bcrst = new ResourceToken("Digger BCRST", "BCRST", address(this));
        hcrst = new ResourceToken("Digger HCRST", "HCRST", address(this));
    }

    receive() external payable {}

    function availableReserve() public view returns (uint256) {
        return address(this).balance - totalReservedPayout;
    }

    function requestMint(address to, uint128 scrstAmount, uint128 bcrstAmount, uint128 hcrstAmount)
        external
        onlyOwner
        returns (bytes32 messageId)
    {
        if (to == address(0)) revert ZeroAddress();
        _ensureNonZero(scrstAmount, bcrstAmount, hcrstAmount);

        messageId = resVmtMirror.vmtMintResources(true, address(this), scrstAmount, bcrstAmount, hcrstAmount);
        _storePending(messageId, OperationKind.Mint, to, scrstAmount, bcrstAmount, hcrstAmount, 0);

        emit MintRequested(messageId, to, scrstAmount, bcrstAmount, hcrstAmount);
    }

    function requestRedeem(uint128 scrstAmount, uint128 bcrstAmount, uint128 hcrstAmount)
        external
        returns (bytes32 messageId)
    {
        _ensureNonZero(scrstAmount, bcrstAmount, hcrstAmount);

        uint256 payout = quoteRedeem(scrstAmount, bcrstAmount, hcrstAmount);
        if (availableReserve() < payout) revert InsufficientReserve();

        if (scrstAmount != 0) scrst.burnFrom(msg.sender, scrstAmount);
        if (bcrstAmount != 0) bcrst.burnFrom(msg.sender, bcrstAmount);
        if (hcrstAmount != 0) hcrst.burnFrom(msg.sender, hcrstAmount);

        totalReservedPayout += payout;
        messageId = redeemMirror.redeemRedeem(true, scrstAmount, bcrstAmount, hcrstAmount);
        _storePending(messageId, OperationKind.Redeem, msg.sender, scrstAmount, bcrstAmount, hcrstAmount, payout);

        emit RedeemRequested(messageId, msg.sender, scrstAmount, bcrstAmount, hcrstAmount, payout);
    }

    function quoteRedeem(uint128 scrstAmount, uint128 bcrstAmount, uint128 hcrstAmount) public pure returns (uint256) {
        return uint256(scrstAmount) * SCRST_RATE + uint256(bcrstAmount) * BCRST_RATE + uint256(hcrstAmount) * HCRST_RATE;
    }

    function withdrawClaim() external {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert ZeroOperation();

        claimable[msg.sender] = 0;
        totalReservedPayout -= amount;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit ClaimWithdrawn(msg.sender, amount);
    }

    function replyOn_vmtMintResources(bytes32 messageId) external {
        if (msg.sender != address(resVmtMirror)) revert NotMirror();
        Operation memory op = _takePending(messageId, OperationKind.Mint);

        if (op.scrst != 0) scrst.mint(op.user, op.scrst);
        if (op.bcrst != 0) bcrst.mint(op.user, op.bcrst);
        if (op.hcrst != 0) hcrst.mint(op.user, op.hcrst);

        emit MintConfirmed(messageId, op.user, op.scrst, op.bcrst, op.hcrst);
    }

    function replyOn_redeemRedeem(bytes32 messageId, uint128 payout) external {
        if (msg.sender != address(redeemMirror)) revert NotMirror();
        Operation memory op = _takePending(messageId, OperationKind.Redeem);
        if (uint256(payout) != op.payout) revert WrongCallback();

        claimable[op.user] += op.payout;
        emit RedeemConfirmed(messageId, op.user, op.payout);
    }

    function onErrorReply(bytes32 messageId, bytes calldata payload, bytes4 replyCode) external payable {
        Operation memory op = pending[messageId];
        if (op.kind == OperationKind.None) revert UnknownMessage();
        if (
            (op.kind == OperationKind.Mint && msg.sender != address(resVmtMirror))
                || (op.kind == OperationKind.Redeem && msg.sender != address(redeemMirror))
        ) {
            revert NotMirror();
        }

        delete pending[messageId];

        if (op.kind == OperationKind.Redeem) {
            totalReservedPayout -= op.payout;
            if (op.scrst != 0) scrst.mint(op.user, op.scrst);
            if (op.bcrst != 0) bcrst.mint(op.user, op.bcrst);
            if (op.hcrst != 0) hcrst.mint(op.user, op.hcrst);
        }

        emit OperationFailed(messageId, op.user, op.kind, abi.encodePacked(replyCode, payload));
    }

    function _storePending(
        bytes32 messageId,
        OperationKind kind,
        address user,
        uint128 scrstAmount,
        uint128 bcrstAmount,
        uint128 hcrstAmount,
        uint256 payout
    ) private {
        if (messageId == bytes32(0)) revert UnknownMessage();
        if (pending[messageId].kind != OperationKind.None) revert DuplicateMessage();

        pending[messageId] = Operation({
            kind: kind, user: user, scrst: scrstAmount, bcrst: bcrstAmount, hcrst: hcrstAmount, payout: payout
        });
    }

    function _takePending(bytes32 messageId, OperationKind expectedKind) private returns (Operation memory op) {
        op = pending[messageId];
        if (op.kind == OperationKind.None) revert UnknownMessage();
        if (op.kind != expectedKind) revert WrongCallback();
        delete pending[messageId];
    }

    function _ensureNonZero(uint128 scrstAmount, uint128 bcrstAmount, uint128 hcrstAmount) private pure {
        if (scrstAmount == 0 && bcrstAmount == 0 && hcrstAmount == 0) revert ZeroOperation();
    }
}
