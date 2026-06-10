// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDiggerRedeemMirror, IDiggerRedeemMirrorCallbacks} from "../generated/DiggerRedeemMirror.sol";

contract MockDiggerRedeemMirror is IDiggerRedeemMirror {
    address public adapter;
    uint256 public nonce;
    address public lastCaller;
    uint128 public lastScrst;
    uint128 public lastBcrst;
    uint128 public lastHcrst;

    function setAdapter(address adapter_) external {
        adapter = adapter_;
    }

    function redeemRedeem(bool, uint128 scrst, uint128 bcrst, uint128 hcrst) external returns (bytes32 messageId) {
        lastCaller = msg.sender;
        lastScrst = scrst;
        lastBcrst = bcrst;
        lastHcrst = hcrst;
        messageId = keccak256(abi.encode("redeemRedeem", msg.sender, ++nonce));
    }

    function succeed(bytes32 messageId, uint128 payout) external {
        IDiggerRedeemMirrorCallbacks(adapter).replyOn_redeemRedeem(messageId, payout);
    }

    function fail(bytes32 messageId, bytes calldata reason) external {
        IDiggerRedeemMirrorCallbacks(adapter).onErrorReply(messageId, reason, bytes4(0));
    }

    function create(bool, address, uint128, uint128, uint128, uint128) external returns (bytes32 messageId) {}
    function redeemAvailableReserve(bool) external returns (bytes32 messageId) {}
    function redeemBcrstRate(bool) external returns (bytes32 messageId) {}
    function redeemCancelRedeem(bool, uint128) external returns (bytes32 messageId) {}
    function redeemConfirmRedeem(bool, uint128) external returns (bytes32 messageId) {}
    function redeemDepositReserve(bool) external payable returns (bytes32 messageId) {}
    function redeemHcrstRate(bool) external returns (bytes32 messageId) {}
    function redeemLockedBalance(bool) external returns (bytes32 messageId) {}
    function redeemPendingRedeemCount(bool) external returns (bytes32 messageId) {}
    function redeemReserveBalance(bool) external returns (bytes32 messageId) {}
    function redeemScrstRate(bool) external returns (bytes32 messageId) {}
    function redeemTotalPaid(bool) external returns (bytes32 messageId) {}
    function redeemTotalRedeemedBcrst(bool) external returns (bytes32 messageId) {}
    function redeemTotalRedeemedHcrst(bool) external returns (bytes32 messageId) {}
    function redeemTotalRedeemedScrst(bool) external returns (bytes32 messageId) {}
    function redeemVaraUnit(bool) external returns (bytes32 messageId) {}
    function adminAddAdmin(bool, address) external returns (bytes32 messageId) {}
    function adminAdmins(bool) external returns (bytes32 messageId) {}
    function adminIsAdmin(bool, address) external returns (bytes32 messageId) {}
    function adminIsPaused(bool) external returns (bytes32 messageId) {}
    function adminPause(bool) external returns (bytes32 messageId) {}
    function adminRemoveAdmin(bool, address) external returns (bytes32 messageId) {}
    function adminResContract(bool) external returns (bytes32 messageId) {}
    function adminSetRateConfig(bool, uint128, uint128, uint128, uint128) external returns (bytes32 messageId) {}
    function adminSetRates(bool, uint128, uint128, uint128) external returns (bytes32 messageId) {}
    function adminSetResContract(bool, address) external returns (bytes32 messageId) {}
    function adminUnpause(bool) external returns (bytes32 messageId) {}
    function adminWithdrawFunds(bool, uint128) external returns (bytes32 messageId) {}
}
