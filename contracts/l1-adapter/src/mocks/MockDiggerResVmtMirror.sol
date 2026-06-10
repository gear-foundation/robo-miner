// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDiggerResVmtMirror, IDiggerResVmtMirrorCallbacks} from "../generated/DiggerResVmtMirror.sol";

contract MockDiggerResVmtMirror is IDiggerResVmtMirror {
    address public adapter;
    uint256 public nonce;
    address public lastTo;
    uint128 public lastScrst;
    uint128 public lastBcrst;
    uint128 public lastHcrst;

    function setAdapter(address adapter_) external {
        adapter = adapter_;
    }

    function vmtMintResources(bool, address to, uint128 scrst, uint128 bcrst, uint128 hcrst)
        external
        returns (bytes32 messageId)
    {
        lastTo = to;
        lastScrst = scrst;
        lastBcrst = bcrst;
        lastHcrst = hcrst;
        messageId = keccak256(abi.encode("vmtMintResources", msg.sender, ++nonce));
    }

    function succeed(bytes32 messageId) external {
        IDiggerResVmtMirrorCallbacks(adapter).replyOn_vmtMintResources(messageId);
    }

    function fail(bytes32 messageId, bytes calldata reason) external {
        IDiggerResVmtMirrorCallbacks(adapter).onErrorReply(messageId, reason, bytes4(0));
    }

    function create(bool, address, address) external returns (bytes32 messageId) {}
    function vmtApprove(bool, address) external returns (bytes32 messageId) {}
    function vmtBalanceOf(bool, address, uint128) external returns (bytes32 messageId) {}
    function vmtBatchTransferFrom(bool, address, address, uint128[] calldata, uint128[] calldata)
        external
        returns (bytes32 messageId)
    {}
    function vmtBcrstTokenId(bool) external returns (bytes32 messageId) {}
    function vmtBurnForRedeem(bool, uint128, address, uint128, uint128, uint128) external returns (bytes32 messageId) {}
    function vmtDecimals(bool) external returns (bytes32 messageId) {}
    function vmtHcrstTokenId(bool) external returns (bytes32 messageId) {}
    function vmtIsApproved(bool, address, address) external returns (bytes32 messageId) {}
    function vmtName(bool) external returns (bytes32 messageId) {}
    function vmtScrstTokenId(bool) external returns (bytes32 messageId) {}
    function vmtSymbol(bool) external returns (bytes32 messageId) {}
    function vmtTotalSupplyOf(bool, uint128) external returns (bytes32 messageId) {}
    function vmtTransferFrom(bool, address, address, uint128, uint128) external returns (bytes32 messageId) {}
    function adminAddAdmin(bool, address) external returns (bytes32 messageId) {}
    function adminAddMinter(bool, address) external returns (bytes32 messageId) {}
    function adminAdmins(bool) external returns (bytes32 messageId) {}
    function adminIsAdmin(bool, address) external returns (bytes32 messageId) {}
    function adminIsMinter(bool, address) external returns (bytes32 messageId) {}
    function adminIsPaused(bool) external returns (bytes32 messageId) {}
    function adminMinters(bool) external returns (bytes32 messageId) {}
    function adminPause(bool) external returns (bytes32 messageId) {}
    function adminRedeemContract(bool) external returns (bytes32 messageId) {}
    function adminRemoveAdmin(bool, address) external returns (bytes32 messageId) {}
    function adminRemoveMinter(bool, address) external returns (bytes32 messageId) {}
    function adminSetRedeemContract(bool, address) external returns (bytes32 messageId) {}
    function adminUnpause(bool) external returns (bytes32 messageId) {}
}
