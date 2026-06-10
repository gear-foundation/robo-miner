// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DiggerL1Adapter} from "../src/DiggerL1Adapter.sol";
import {MockDiggerResVmtMirror} from "../src/mocks/MockDiggerResVmtMirror.sol";
import {MockDiggerRedeemMirror} from "../src/mocks/MockDiggerRedeemMirror.sol";

interface Vm {
    function deal(address account, uint256 amount) external;
    function prank(address account) external;
    function expectRevert(bytes4 selector) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData) external;
}

contract DiggerL1AdapterTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant USER = address(0xA11CE);
    uint256 private constant VARA_UNIT = 1_000_000_000_000;
    MockDiggerResVmtMirror private resMirror;
    MockDiggerRedeemMirror private redeemMirror;
    DiggerL1Adapter private adapter;

    event MintRequested(bytes32 indexed messageId, address indexed user, uint128 scrst, uint128 bcrst, uint128 hcrst);
    event MintConfirmed(bytes32 indexed messageId, address indexed user, uint128 scrst, uint128 bcrst, uint128 hcrst);
    event RedeemRequested(
        bytes32 indexed messageId, address indexed user, uint128 scrst, uint128 bcrst, uint128 hcrst, uint256 payout
    );
    event RedeemConfirmed(bytes32 indexed messageId, address indexed user, uint256 payout);
    event OperationFailed(
        bytes32 indexed messageId, address indexed user, DiggerL1Adapter.OperationKind kind, bytes reason
    );
    event ClaimWithdrawn(address indexed user, uint256 amount);

    function setUp() public {
        resMirror = new MockDiggerResVmtMirror();
        redeemMirror = new MockDiggerRedeemMirror();
        adapter = new DiggerL1Adapter(address(resMirror), address(redeemMirror));
        resMirror.setAdapter(address(adapter));
        redeemMirror.setAdapter(address(adapter));
        vm.deal(address(adapter), 10_000 ether);
    }

    function testMintIsPendingUntilVmtCallback() public {
        bytes32 expectedMessageId = _expectedVmtMessageId(1);
        vm.expectEmit(true, true, false, true);
        emit MintRequested(expectedMessageId, USER, 10, 2, 1);
        bytes32 messageId = adapter.requestMint(USER, 10, 2, 1);
        assertEq(messageId, expectedMessageId);

        assertEq(resMirror.lastTo(), address(adapter));
        assertEq(adapter.scrst().balanceOf(USER), 0);
        assertEq(adapter.bcrst().balanceOf(USER), 0);
        assertEq(adapter.hcrst().balanceOf(USER), 0);

        vm.expectEmit(true, true, false, true);
        emit MintConfirmed(messageId, USER, 10, 2, 1);
        resMirror.succeed(messageId);

        assertEq(adapter.scrst().balanceOf(USER), 10);
        assertEq(adapter.bcrst().balanceOf(USER), 2);
        assertEq(adapter.hcrst().balanceOf(USER), 1);
    }

    function testVaraSideMintAndRedeemUseSameAdapterActor() public {
        bytes32 mintMessageId = adapter.requestMint(USER, 2, 0, 0);
        assertEq(resMirror.lastTo(), address(adapter));
        resMirror.succeed(mintMessageId);

        vm.prank(USER);
        bytes32 redeemMessageId = adapter.requestRedeem(1, 0, 0);

        assertEq(redeemMirror.lastCaller(), address(adapter));
        assertEq(redeemMessageId, _expectedRedeemMessageId(1));
    }

    function testOnlyOwnerCanRequestMint() public {
        vm.prank(USER);
        vm.expectRevert(DiggerL1Adapter.NotOwner.selector);
        adapter.requestMint(USER, 1, 0, 0);
    }

    function testMintRejectsZeroRecipientAndEmptyAmounts() public {
        vm.expectRevert(DiggerL1Adapter.ZeroAddress.selector);
        adapter.requestMint(address(0), 1, 0, 0);

        vm.expectRevert(DiggerL1Adapter.ZeroOperation.selector);
        adapter.requestMint(USER, 0, 0, 0);
    }

    function testMintErrorClearsPendingWithoutMinting() public {
        bytes32 messageId = adapter.requestMint(USER, 10, 0, 0);

        vm.expectEmit(true, true, false, true);
        emit OperationFailed(
            messageId, USER, DiggerL1Adapter.OperationKind.Mint, abi.encodePacked(bytes4(0), bytes("vara mint failed"))
        );
        resMirror.fail(messageId, bytes("vara mint failed"));

        assertEq(adapter.scrst().balanceOf(USER), 0);

        vm.expectRevert(DiggerL1Adapter.UnknownMessage.selector);
        resMirror.succeed(messageId);
    }

    function testRedeemBurnsL1TokensAndCreditsClaimOnCallback() public {
        _mintToUser(3, 1, 0);

        uint256 expectedPayout = adapter.quoteRedeem(1, 1, 0);
        vm.prank(USER);
        bytes32 expectedMessageId = _expectedRedeemMessageId(1);
        vm.expectEmit(true, true, false, true);
        emit RedeemRequested(expectedMessageId, USER, 1, 1, 0, expectedPayout);
        bytes32 messageId = adapter.requestRedeem(1, 1, 0);
        assertEq(messageId, expectedMessageId);

        assertEq(adapter.scrst().balanceOf(USER), 2);
        assertEq(adapter.bcrst().balanceOf(USER), 0);
        assertEq(adapter.totalReservedPayout(), expectedPayout);
        assertEq(adapter.claimable(USER), 0);

        vm.expectEmit(true, true, false, true);
        emit RedeemConfirmed(messageId, USER, expectedPayout);
        redeemMirror.succeed(messageId, uint128(expectedPayout));

        assertEq(adapter.claimable(USER), expectedPayout);
        assertEq(adapter.totalReservedPayout(), expectedPayout);

        uint256 userBefore = USER.balance;
        vm.prank(USER);
        vm.expectEmit(true, false, false, true);
        emit ClaimWithdrawn(USER, expectedPayout);
        adapter.withdrawClaim();

        assertEq(USER.balance, userBefore + expectedPayout);
        assertEq(adapter.claimable(USER), 0);
        assertEq(adapter.totalReservedPayout(), 0);
    }

    function testRedeemErrorRefundsBurnedTokensAndUnreservesPayout() public {
        _mintToUser(1, 1, 1);

        uint256 expectedPayout = adapter.quoteRedeem(1, 1, 1);
        vm.prank(USER);
        bytes32 messageId = adapter.requestRedeem(1, 1, 1);

        assertEq(adapter.totalReservedPayout(), expectedPayout);
        assertEq(adapter.scrst().balanceOf(USER), 0);
        assertEq(adapter.bcrst().balanceOf(USER), 0);
        assertEq(adapter.hcrst().balanceOf(USER), 0);

        vm.expectEmit(true, true, false, true);
        emit OperationFailed(
            messageId,
            USER,
            DiggerL1Adapter.OperationKind.Redeem,
            abi.encodePacked(bytes4(0), bytes("vara redeem failed"))
        );
        redeemMirror.fail(messageId, bytes("vara redeem failed"));

        assertEq(adapter.totalReservedPayout(), 0);
        assertEq(adapter.claimable(USER), 0);
        assertEq(adapter.scrst().balanceOf(USER), 1);
        assertEq(adapter.bcrst().balanceOf(USER), 1);
        assertEq(adapter.hcrst().balanceOf(USER), 1);
    }

    function testRedeemRejectsEmptyAmountsAndWithdrawRequiresClaim() public {
        vm.prank(USER);
        vm.expectRevert(DiggerL1Adapter.ZeroOperation.selector);
        adapter.requestRedeem(0, 0, 0);

        vm.prank(USER);
        vm.expectRevert(DiggerL1Adapter.ZeroOperation.selector);
        adapter.withdrawClaim();
    }

    function testCallbackSenderMustBeTrustedMirror() public {
        bytes32 messageId = adapter.requestMint(USER, 1, 0, 0);

        vm.expectRevert(DiggerL1Adapter.NotMirror.selector);
        adapter.replyOn_vmtMintResources(messageId);
    }

    function testUnknownMessageCannotComplete() public {
        vm.expectRevert(DiggerL1Adapter.UnknownMessage.selector);
        resMirror.succeed(bytes32(uint256(0xdead)));
    }

    function testErrorCallbackSenderMustBeTrustedMirror() public {
        bytes32 messageId = adapter.requestMint(USER, 1, 0, 0);

        vm.expectRevert(DiggerL1Adapter.NotMirror.selector);
        adapter.onErrorReply(messageId, bytes("bad sender"), bytes4(0));
    }

    function testWrongMirrorCallbackKindIsRejected() public {
        bytes32 messageId = adapter.requestMint(USER, 1, 0, 0);

        vm.expectRevert(DiggerL1Adapter.WrongCallback.selector);
        redeemMirror.succeed(messageId, 0);

        resMirror.succeed(messageId);
        assertEq(adapter.scrst().balanceOf(USER), 1);
    }

    function testRedeemCallbackMustMatchExpectedPayout() public {
        _mintToUser(1, 0, 0);

        uint256 expectedPayout = adapter.quoteRedeem(1, 0, 0);
        vm.prank(USER);
        bytes32 messageId = adapter.requestRedeem(1, 0, 0);

        vm.expectRevert(DiggerL1Adapter.WrongCallback.selector);
        redeemMirror.succeed(messageId, uint128(expectedPayout + 1));

        redeemMirror.succeed(messageId, uint128(expectedPayout));
        assertEq(adapter.claimable(USER), expectedPayout);
    }

    function testRedeemCannotOverReserveVault() public {
        DiggerL1Adapter thinAdapter = new DiggerL1Adapter(address(resMirror), address(redeemMirror));
        resMirror.setAdapter(address(thinAdapter));
        redeemMirror.setAdapter(address(thinAdapter));
        vm.deal(address(thinAdapter), 65 * VARA_UNIT);

        bytes32 messageId = thinAdapter.requestMint(USER, 1, 0, 0);
        resMirror.succeed(messageId);

        vm.prank(USER);
        vm.expectRevert(DiggerL1Adapter.InsufficientReserve.selector);
        thinAdapter.requestRedeem(1, 0, 0);
    }

    function testConstructorRejectsZeroAddresses() public {
        vm.expectRevert(DiggerL1Adapter.ZeroAddress.selector);
        new DiggerL1Adapter(address(0), address(redeemMirror));

        vm.expectRevert(DiggerL1Adapter.ZeroAddress.selector);
        new DiggerL1Adapter(address(resMirror), address(0));
    }

    function _mintToUser(uint128 scrstAmount, uint128 bcrstAmount, uint128 hcrstAmount) private {
        bytes32 messageId = adapter.requestMint(USER, scrstAmount, bcrstAmount, hcrstAmount);
        resMirror.succeed(messageId);
    }

    function _expectedVmtMessageId(uint256 nonce) private view returns (bytes32) {
        return keccak256(abi.encode("vmtMintResources", address(adapter), nonce));
    }

    function _expectedRedeemMessageId(uint256 nonce) private view returns (bytes32) {
        return keccak256(abi.encode("redeemRedeem", address(adapter), nonce));
    }

    function assertEq(uint256 actual, uint256 expected) private pure {
        if (actual != expected) {
            revert("assert uint failed");
        }
    }

    function assertEq(bytes32 actual, bytes32 expected) private pure {
        if (actual != expected) {
            revert("assert bytes32 failed");
        }
    }

    function assertEq(address actual, address expected) private pure {
        if (actual != expected) {
            revert("assert address failed");
        }
    }
}
