// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IDiggerResVmtMirror {
    event Approval(uint8[32], uint8[32]);

    event BatchTransfer(uint8[32], uint8[32]);

    event Burned(uint8[32], uint128, uint128, uint128);

    event Minted(uint8[32], uint128, uint128, uint128);

    event RedeemBurnRejected(uint128, uint8[32], uint128, uint128, uint128);

    event Transfer(uint8[32], uint8[32], uint128, uint128);

    event AdminAdded(uint8[32]);

    event AdminRemoved(uint8[32]);

    event MinterAdded(uint8[32]);

    event MinterRemoved(uint8[32]);

    event Paused(uint8[32]);

    event RedeemContractUpdated(uint8[32], uint8[32]);

    event Unpaused(uint8[32]);

    function create(bool _callReply, address redeemContract, address minter) external returns (bytes32 messageId);

    function vmtApprove(bool _callReply, address operator) external returns (bytes32 messageId);

    function vmtBalanceOf(bool _callReply, address account, uint128 id) external returns (bytes32 messageId);

    function vmtBatchTransferFrom(bool _callReply, address from, address to, uint128[] calldata ids, uint128[] calldata amounts) external returns (bytes32 messageId);

    function vmtBcrstTokenId(bool _callReply) external returns (bytes32 messageId);

    function vmtBurnForRedeem(bool _callReply, uint128 redeemId, address owner, uint128 scrst, uint128 bcrst, uint128 hcrst) external returns (bytes32 messageId);

    function vmtDecimals(bool _callReply) external returns (bytes32 messageId);

    function vmtHcrstTokenId(bool _callReply) external returns (bytes32 messageId);

    function vmtIsApproved(bool _callReply, address account, address operator) external returns (bytes32 messageId);

    function vmtMintResources(bool _callReply, address to, uint128 scrst, uint128 bcrst, uint128 hcrst) external returns (bytes32 messageId);

    function vmtName(bool _callReply) external returns (bytes32 messageId);

    function vmtScrstTokenId(bool _callReply) external returns (bytes32 messageId);

    function vmtSymbol(bool _callReply) external returns (bytes32 messageId);

    function vmtTotalSupplyOf(bool _callReply, uint128 id) external returns (bytes32 messageId);

    function vmtTransferFrom(bool _callReply, address from, address to, uint128 id, uint128 amount) external returns (bytes32 messageId);

    function adminAddAdmin(bool _callReply, address admin) external returns (bytes32 messageId);

    function adminAddMinter(bool _callReply, address minter) external returns (bytes32 messageId);

    function adminAdmins(bool _callReply) external returns (bytes32 messageId);

    function adminIsAdmin(bool _callReply, address account) external returns (bytes32 messageId);

    function adminIsMinter(bool _callReply, address account) external returns (bytes32 messageId);

    function adminIsPaused(bool _callReply) external returns (bytes32 messageId);

    function adminMinters(bool _callReply) external returns (bytes32 messageId);

    function adminPause(bool _callReply) external returns (bytes32 messageId);

    function adminRedeemContract(bool _callReply) external returns (bytes32 messageId);

    function adminRemoveAdmin(bool _callReply, address admin) external returns (bytes32 messageId);

    function adminRemoveMinter(bool _callReply, address minter) external returns (bytes32 messageId);

    function adminSetRedeemContract(bool _callReply, address redeemContract) external returns (bytes32 messageId);

    function adminUnpause(bool _callReply) external returns (bytes32 messageId);
}

contract DiggerResVmtMirrorAbi is IDiggerResVmtMirror {
    function create(bool _callReply, address redeemContract, address minter) external returns (bytes32 messageId) {}

    function vmtApprove(bool _callReply, address operator) external returns (bytes32 messageId) {}

    function vmtBalanceOf(bool _callReply, address account, uint128 id) external returns (bytes32 messageId) {}

    function vmtBatchTransferFrom(bool _callReply, address from, address to, uint128[] calldata ids, uint128[] calldata amounts) external returns (bytes32 messageId) {}

    function vmtBcrstTokenId(bool _callReply) external returns (bytes32 messageId) {}

    function vmtBurnForRedeem(bool _callReply, uint128 redeemId, address owner, uint128 scrst, uint128 bcrst, uint128 hcrst) external returns (bytes32 messageId) {}

    function vmtDecimals(bool _callReply) external returns (bytes32 messageId) {}

    function vmtHcrstTokenId(bool _callReply) external returns (bytes32 messageId) {}

    function vmtIsApproved(bool _callReply, address account, address operator) external returns (bytes32 messageId) {}

    function vmtMintResources(bool _callReply, address to, uint128 scrst, uint128 bcrst, uint128 hcrst) external returns (bytes32 messageId) {}

    function vmtName(bool _callReply) external returns (bytes32 messageId) {}

    function vmtScrstTokenId(bool _callReply) external returns (bytes32 messageId) {}

    function vmtSymbol(bool _callReply) external returns (bytes32 messageId) {}

    function vmtTotalSupplyOf(bool _callReply, uint128 id) external returns (bytes32 messageId) {}

    function vmtTransferFrom(bool _callReply, address from, address to, uint128 id, uint128 amount) external returns (bytes32 messageId) {}

    function adminAddAdmin(bool _callReply, address admin) external returns (bytes32 messageId) {}

    function adminAddMinter(bool _callReply, address minter) external returns (bytes32 messageId) {}

    function adminAdmins(bool _callReply) external returns (bytes32 messageId) {}

    function adminIsAdmin(bool _callReply, address account) external returns (bytes32 messageId) {}

    function adminIsMinter(bool _callReply, address account) external returns (bytes32 messageId) {}

    function adminIsPaused(bool _callReply) external returns (bytes32 messageId) {}

    function adminMinters(bool _callReply) external returns (bytes32 messageId) {}

    function adminPause(bool _callReply) external returns (bytes32 messageId) {}

    function adminRedeemContract(bool _callReply) external returns (bytes32 messageId) {}

    function adminRemoveAdmin(bool _callReply, address admin) external returns (bytes32 messageId) {}

    function adminRemoveMinter(bool _callReply, address minter) external returns (bytes32 messageId) {}

    function adminSetRedeemContract(bool _callReply, address redeemContract) external returns (bytes32 messageId) {}

    function adminUnpause(bool _callReply) external returns (bytes32 messageId) {}
}

interface IDiggerResVmtMirrorCallbacks {
    function replyOn_create(bytes32 messageId) external;

    function replyOn_vmtApprove(bytes32 messageId, bool reply) external;

    function replyOn_vmtBalanceOf(bytes32 messageId, uint128 reply) external;

    function replyOn_vmtBatchTransferFrom(bytes32 messageId) external;

    function replyOn_vmtBcrstTokenId(bytes32 messageId, uint128 reply) external;

    function replyOn_vmtBurnForRedeem(bytes32 messageId) external;

    function replyOn_vmtDecimals(bytes32 messageId, uint128 reply) external;

    function replyOn_vmtHcrstTokenId(bytes32 messageId, uint128 reply) external;

    function replyOn_vmtIsApproved(bytes32 messageId, bool reply) external;

    function replyOn_vmtMintResources(bytes32 messageId) external;

    function replyOn_vmtName(bytes32 messageId, string calldata reply) external;

    function replyOn_vmtScrstTokenId(bytes32 messageId, uint128 reply) external;

    function replyOn_vmtSymbol(bytes32 messageId, string calldata reply) external;

    function replyOn_vmtTotalSupplyOf(bytes32 messageId, uint128 reply) external;

    function replyOn_vmtTransferFrom(bytes32 messageId) external;

    function replyOn_adminAddAdmin(bytes32 messageId, bool reply) external;

    function replyOn_adminAddMinter(bytes32 messageId, bool reply) external;

    function replyOn_adminAdmins(bytes32 messageId, address[] calldata reply) external;

    function replyOn_adminIsAdmin(bytes32 messageId, bool reply) external;

    function replyOn_adminIsMinter(bytes32 messageId, bool reply) external;

    function replyOn_adminIsPaused(bytes32 messageId, bool reply) external;

    function replyOn_adminMinters(bytes32 messageId, address[] calldata reply) external;

    function replyOn_adminPause(bytes32 messageId) external;

    function replyOn_adminRedeemContract(bytes32 messageId, address reply) external;

    function replyOn_adminRemoveAdmin(bytes32 messageId, bool reply) external;

    function replyOn_adminRemoveMinter(bytes32 messageId, bool reply) external;

    function replyOn_adminSetRedeemContract(bytes32 messageId) external;

    function replyOn_adminUnpause(bytes32 messageId) external;

    function onErrorReply(bytes32 messageId, bytes calldata payload, bytes4 replyCode) external payable;
}

contract DiggerResVmtMirrorCaller is IDiggerResVmtMirrorCallbacks {
    IDiggerResVmtMirror public immutable VARA_ETH_PROGRAM;

    error UnauthorizedCaller();

    constructor(IDiggerResVmtMirror _varaEthProgram) {
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

    function replyOn_vmtApprove(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_vmtBalanceOf(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_vmtBatchTransferFrom(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_vmtBcrstTokenId(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_vmtBurnForRedeem(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_vmtDecimals(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_vmtHcrstTokenId(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_vmtIsApproved(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_vmtMintResources(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_vmtName(bytes32 messageId, string calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_vmtScrstTokenId(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_vmtSymbol(bytes32 messageId, string calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_vmtTotalSupplyOf(bytes32 messageId, uint128 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_vmtTransferFrom(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminAddAdmin(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminAddMinter(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminAdmins(bytes32 messageId, address[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminIsAdmin(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminIsMinter(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminIsPaused(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminMinters(bytes32 messageId, address[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminPause(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminRedeemContract(bytes32 messageId, address reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminRemoveAdmin(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminRemoveMinter(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminSetRedeemContract(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminUnpause(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function onErrorReply(bytes32 messageId, bytes calldata payload, bytes4 replyCode) external payable onlyVaraEthProgram {
        // TODO: implement this
    }
}
