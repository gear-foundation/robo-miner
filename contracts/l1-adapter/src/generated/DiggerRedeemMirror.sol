// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IDiggerRedeemMirror {
    event RedeemCanceled(uint128, uint8[32], uint128, uint128, uint128, uint128);

    event Redeemed(uint8[32], uint128, uint128, uint128, uint128);

    event RedeemRequested(uint128, uint8[32], uint128, uint128, uint128, uint128);

    event ReserveDeposited(uint8[32], uint128, uint128);

    event ReserveSynced(uint128, uint128);

    event AdminAdded(uint8[32]);

    event AdminRemoved(uint8[32]);

    event FundsWithdrawn(uint8[32], uint128, uint128);

    event Paused(uint8[32]);

    event RatesUpdated(uint128, uint128, uint128);

    event ResContractUpdated(uint8[32], uint8[32]);

    event Unpaused(uint8[32]);

    function create(bool _callReply, address resContract, uint128 scrstRate, uint128 bcrstRate, uint128 hcrstRate)
        external
        returns (bytes32 messageId);

    function redeemAvailableReserve(bool _callReply) external returns (bytes32 messageId);

    function redeemBcrstRate(bool _callReply) external returns (bytes32 messageId);

    function redeemCancelRedeem(bool _callReply, uint128 redeemId) external returns (bytes32 messageId);

    function redeemConfirmRedeem(bool _callReply, uint128 redeemId) external returns (bytes32 messageId);

    function redeemDepositReserve(bool _callReply) external payable returns (bytes32 messageId);

    function redeemHcrstRate(bool _callReply) external returns (bytes32 messageId);

    function redeemLockedBalance(bool _callReply) external returns (bytes32 messageId);

    function redeemPendingRedeemCount(bool _callReply) external returns (bytes32 messageId);

    function redeemRedeem(bool _callReply, uint128 scrst, uint128 bcrst, uint128 hcrst)
        external
        returns (bytes32 messageId);

    function redeemReserveBalance(bool _callReply) external returns (bytes32 messageId);

    function redeemScrstRate(bool _callReply) external returns (bytes32 messageId);

    function redeemTotalPaid(bool _callReply) external returns (bytes32 messageId);

    function redeemTotalRedeemedBcrst(bool _callReply) external returns (bytes32 messageId);

    function redeemTotalRedeemedHcrst(bool _callReply) external returns (bytes32 messageId);

    function redeemTotalRedeemedScrst(bool _callReply) external returns (bytes32 messageId);

    function adminAddAdmin(bool _callReply, address admin) external returns (bytes32 messageId);

    function adminAdmins(bool _callReply) external returns (bytes32 messageId);

    function adminIsAdmin(bool _callReply, address account) external returns (bytes32 messageId);

    function adminIsPaused(bool _callReply) external returns (bytes32 messageId);

    function adminPause(bool _callReply) external returns (bytes32 messageId);

    function adminRemoveAdmin(bool _callReply, address admin) external returns (bytes32 messageId);

    function adminResContract(bool _callReply) external returns (bytes32 messageId);

    function adminSetRates(bool _callReply, uint128 scrstRate, uint128 bcrstRate, uint128 hcrstRate)
        external
        returns (bytes32 messageId);

    function adminSetResContract(bool _callReply, address resContract) external returns (bytes32 messageId);

    function adminUnpause(bool _callReply) external returns (bytes32 messageId);

    function adminWithdrawFunds(bool _callReply, uint128 amount) external returns (bytes32 messageId);
}

contract DiggerRedeemMirrorAbi is IDiggerRedeemMirror {
    function create(bool _callReply, address resContract, uint128 scrstRate, uint128 bcrstRate, uint128 hcrstRate)
        external
        returns (bytes32 messageId)
    {}

    function redeemAvailableReserve(bool _callReply) external returns (bytes32 messageId) {}

    function redeemBcrstRate(bool _callReply) external returns (bytes32 messageId) {}

    function redeemCancelRedeem(bool _callReply, uint128 redeemId) external returns (bytes32 messageId) {}

    function redeemConfirmRedeem(bool _callReply, uint128 redeemId) external returns (bytes32 messageId) {}

    function redeemDepositReserve(bool _callReply) external payable returns (bytes32 messageId) {}

    function redeemHcrstRate(bool _callReply) external returns (bytes32 messageId) {}

    function redeemLockedBalance(bool _callReply) external returns (bytes32 messageId) {}

    function redeemPendingRedeemCount(bool _callReply) external returns (bytes32 messageId) {}

    function redeemRedeem(bool _callReply, uint128 scrst, uint128 bcrst, uint128 hcrst)
        external
        returns (bytes32 messageId)
    {}

    function redeemReserveBalance(bool _callReply) external returns (bytes32 messageId) {}

    function redeemScrstRate(bool _callReply) external returns (bytes32 messageId) {}

    function redeemTotalPaid(bool _callReply) external returns (bytes32 messageId) {}

    function redeemTotalRedeemedBcrst(bool _callReply) external returns (bytes32 messageId) {}

    function redeemTotalRedeemedHcrst(bool _callReply) external returns (bytes32 messageId) {}

    function redeemTotalRedeemedScrst(bool _callReply) external returns (bytes32 messageId) {}

    function adminAddAdmin(bool _callReply, address admin) external returns (bytes32 messageId) {}

    function adminAdmins(bool _callReply) external returns (bytes32 messageId) {}

    function adminIsAdmin(bool _callReply, address account) external returns (bytes32 messageId) {}

    function adminIsPaused(bool _callReply) external returns (bytes32 messageId) {}

    function adminPause(bool _callReply) external returns (bytes32 messageId) {}

    function adminRemoveAdmin(bool _callReply, address admin) external returns (bytes32 messageId) {}

    function adminResContract(bool _callReply) external returns (bytes32 messageId) {}

    function adminSetRates(bool _callReply, uint128 scrstRate, uint128 bcrstRate, uint128 hcrstRate)
        external
        returns (bytes32 messageId)
    {}

    function adminSetResContract(bool _callReply, address resContract) external returns (bytes32 messageId) {}

    function adminUnpause(bool _callReply) external returns (bytes32 messageId) {}

    function adminWithdrawFunds(bool _callReply, uint128 amount) external returns (bytes32 messageId) {}
}

interface IDiggerRedeemMirrorCallbacks {
    function replyOn_create(bytes32 messageId) external;

    function replyOn_redeemAvailableReserve(bytes32 messageId, uint128 reply) external;

    function replyOn_redeemBcrstRate(bytes32 messageId, uint128 reply) external;

    function replyOn_redeemCancelRedeem(bytes32 messageId) external;

    function replyOn_redeemConfirmRedeem(bytes32 messageId, uint128 reply) external;

    function replyOn_redeemDepositReserve(bytes32 messageId, uint128 reply) external;

    function replyOn_redeemHcrstRate(bytes32 messageId, uint128 reply) external;

    function replyOn_redeemLockedBalance(bytes32 messageId, uint128 reply) external;

    function replyOn_redeemPendingRedeemCount(bytes32 messageId, uint128 reply) external;

    function replyOn_redeemRedeem(bytes32 messageId, uint128 reply) external;

    function replyOn_redeemReserveBalance(bytes32 messageId, uint128 reply) external;

    function replyOn_redeemScrstRate(bytes32 messageId, uint128 reply) external;

    function replyOn_redeemTotalPaid(bytes32 messageId, uint128 reply) external;

    function replyOn_redeemTotalRedeemedBcrst(bytes32 messageId, uint128 reply) external;

    function replyOn_redeemTotalRedeemedHcrst(bytes32 messageId, uint128 reply) external;

    function replyOn_redeemTotalRedeemedScrst(bytes32 messageId, uint128 reply) external;

    function replyOn_adminAddAdmin(bytes32 messageId, bool reply) external;

    function replyOn_adminAdmins(bytes32 messageId, address[] calldata reply) external;

    function replyOn_adminIsAdmin(bytes32 messageId, bool reply) external;

    function replyOn_adminIsPaused(bytes32 messageId, bool reply) external;

    function replyOn_adminPause(bytes32 messageId) external;

    function replyOn_adminRemoveAdmin(bytes32 messageId, bool reply) external;

    function replyOn_adminResContract(bytes32 messageId, address reply) external;

    function replyOn_adminSetRates(bytes32 messageId) external;

    function replyOn_adminSetResContract(bytes32 messageId) external;

    function replyOn_adminUnpause(bytes32 messageId) external;

    function replyOn_adminWithdrawFunds(bytes32 messageId) external payable;

    function onErrorReply(bytes32 messageId, bytes calldata payload, bytes4 replyCode) external payable;
}

contract DiggerRedeemMirrorCaller is IDiggerRedeemMirrorCallbacks {
    IDiggerRedeemMirror public immutable VARA_ETH_PROGRAM;

    error UnauthorizedCaller();

    constructor(IDiggerRedeemMirror _varaEthProgram) {
        VARA_ETH_PROGRAM = _varaEthProgram;
    }

    modifier onlyVaraEthProgram() {
        _onlyVaraEthProgram();
        _;
    }

    function _onlyVaraEthProgram() internal view {
        if (msg.sender != address(VARA_ETH_PROGRAM)) {
            revert UnauthorizedCaller();
        }
    }

    function replyOn_create(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemAvailableReserve(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemBcrstRate(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemCancelRedeem(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemConfirmRedeem(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemDepositReserve(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemHcrstRate(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemLockedBalance(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemPendingRedeemCount(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemRedeem(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemReserveBalance(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemScrstRate(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemTotalPaid(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemTotalRedeemedBcrst(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemTotalRedeemedHcrst(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_redeemTotalRedeemedScrst(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminAddAdmin(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminAdmins(bytes32 messageId, address[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminIsAdmin(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminIsPaused(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminPause(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminRemoveAdmin(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminResContract(bytes32 messageId, address reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminSetRates(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminSetResContract(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminUnpause(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminWithdrawFunds(bytes32 messageId) external payable onlyVaraEthProgram {
        // TODO: implement this
    }

    function onErrorReply(bytes32 messageId, bytes calldata payload, bytes4 replyCode)
        external
        payable
        onlyVaraEthProgram
    {
        // TODO: implement this
    }
}
