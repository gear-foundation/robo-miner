// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IDiggerWorld {
    event AgentDied(uint64, uint8[32], uint32, uint32, uint32);

    event AgentExited(uint64, uint8[32]);

    event AgentMoved(uint64, uint8[32], uint32, uint32, uint32, uint32);

    event AgentRegistered(uint64, uint8[32]);

    event AgentSpawned(uint64, uint8[32], uint32, uint32);

    event AgentSurfaced(uint64, uint8[32], uint32, uint32, uint32);

    event LadderPlaced(uint64, uint8[32], uint32, uint32, uint32);

    event ResourceExtracted(uint64, uint8[32], uint32, uint32, uint32, uint32);

    event ResourcesMinted(uint64, uint8[32], uint32, uint32, uint32);

    event StoneMoved(uint64, uint8[32], uint32, uint32, uint32, uint32);

    event TileDrilled(uint64, uint8[32], uint32, uint32, uint32, uint32);

    event Killed(uint8[32]);

    event MapGenerated(uint64, uint64);

    event ResourceVmtUpdated(uint8[32], uint8[32]);

    event SessionFinished(uint64);

    event SessionStarted(uint64);

    function create(bool _callReply) external returns (bytes32 messageId);

    function worldAgentOf(bool _callReply, address owner) external returns (bytes32 messageId);

    function worldAgents(bool _callReply) external returns (bytes32 messageId);

    function worldConfig(bool _callReply) external returns (bytes32 messageId);

    function worldDrill(bool _callReply, uint32 direction) external returns (bytes32 messageId);

    function worldExit(bool _callReply) external returns (bytes32 messageId);

    function worldInventoryOf(bool _callReply, address owner) external returns (bytes32 messageId);

    function worldIsDug(bool _callReply, uint32 x, uint32 y) external returns (bytes32 messageId);

    function worldMapSnapshot(bool _callReply) external returns (bytes32 messageId);

    function worldMintResources(bool _callReply) external returns (bytes32 messageId);

    function worldMoveAgent(bool _callReply, uint32 direction) external returns (bytes32 messageId);

    function worldPlaceLadder(bool _callReply, uint32 direction) external returns (bytes32 messageId);

    function worldRegister(bool _callReply) external returns (bytes32 messageId);

    function worldSession(bool _callReply) external returns (bytes32 messageId);

    function worldSurface(bool _callReply) external returns (bytes32 messageId);

    function worldTileAt(bool _callReply, uint32 x, uint32 y) external returns (bytes32 messageId);

    function adminAdmin(bool _callReply) external returns (bytes32 messageId);

    function adminFinishSession(bool _callReply) external returns (bytes32 messageId);

    function adminKill(bool _callReply, address inheritor) external returns (bytes32 messageId);

    function adminResetMap(bool _callReply, uint64 seed) external returns (bytes32 messageId);

    function adminResourceVmt(bool _callReply) external returns (bytes32 messageId);

    function adminSetResourceVmt(bool _callReply, address resourceVmt) external returns (bytes32 messageId);

    function adminStartSession(bool _callReply) external returns (bytes32 messageId);

    function adminUploadMap(bool _callReply, uint64 seed, uint32[] calldata map) external returns (bytes32 messageId);
}

contract DiggerWorldAbi is IDiggerWorld {
    function create(bool _callReply) external returns (bytes32 messageId) {}

    function worldAgentOf(bool _callReply, address owner) external returns (bytes32 messageId) {}

    function worldAgents(bool _callReply) external returns (bytes32 messageId) {}

    function worldConfig(bool _callReply) external returns (bytes32 messageId) {}

    function worldDrill(bool _callReply, uint32 direction) external returns (bytes32 messageId) {}

    function worldExit(bool _callReply) external returns (bytes32 messageId) {}

    function worldInventoryOf(bool _callReply, address owner) external returns (bytes32 messageId) {}

    function worldIsDug(bool _callReply, uint32 x, uint32 y) external returns (bytes32 messageId) {}

    function worldMapSnapshot(bool _callReply) external returns (bytes32 messageId) {}

    function worldMintResources(bool _callReply) external returns (bytes32 messageId) {}

    function worldMoveAgent(bool _callReply, uint32 direction) external returns (bytes32 messageId) {}

    function worldPlaceLadder(bool _callReply, uint32 direction) external returns (bytes32 messageId) {}

    function worldRegister(bool _callReply) external returns (bytes32 messageId) {}

    function worldSession(bool _callReply) external returns (bytes32 messageId) {}

    function worldSurface(bool _callReply) external returns (bytes32 messageId) {}

    function worldTileAt(bool _callReply, uint32 x, uint32 y) external returns (bytes32 messageId) {}

    function adminAdmin(bool _callReply) external returns (bytes32 messageId) {}

    function adminFinishSession(bool _callReply) external returns (bytes32 messageId) {}

    function adminKill(bool _callReply, address inheritor) external returns (bytes32 messageId) {}

    function adminResetMap(bool _callReply, uint64 seed) external returns (bytes32 messageId) {}

    function adminResourceVmt(bool _callReply) external returns (bytes32 messageId) {}

    function adminSetResourceVmt(bool _callReply, address resourceVmt) external returns (bytes32 messageId) {}

    function adminStartSession(bool _callReply) external returns (bytes32 messageId) {}

    function adminUploadMap(bool _callReply, uint64 seed, uint32[] calldata map) external returns (bytes32 messageId) {}
}

interface IDiggerWorldCallbacks {
    function replyOn_create(bytes32 messageId) external;

    function replyOn_worldAgentOf(bytes32 messageId, uint128[] calldata reply) external;

    function replyOn_worldAgents(bytes32 messageId, address[] calldata reply) external;

    function replyOn_worldConfig(bytes32 messageId, uint32[] calldata reply) external;

    function replyOn_worldDrill(bytes32 messageId, uint128[] calldata reply) external;

    function replyOn_worldExit(bytes32 messageId, uint128[] calldata reply) external;

    function replyOn_worldInventoryOf(bytes32 messageId, uint32[] calldata reply) external;

    function replyOn_worldIsDug(bytes32 messageId, bool reply) external;

    function replyOn_worldMapSnapshot(bytes32 messageId, uint32[] calldata reply) external;

    function replyOn_worldMintResources(bytes32 messageId, uint128[] calldata reply) external;

    function replyOn_worldMoveAgent(bytes32 messageId, uint128[] calldata reply) external;

    function replyOn_worldPlaceLadder(bytes32 messageId, uint128[] calldata reply) external;

    function replyOn_worldRegister(bytes32 messageId, uint128[] calldata reply) external;

    function replyOn_worldSession(bytes32 messageId, uint128[] calldata reply) external;

    function replyOn_worldSurface(bytes32 messageId, uint128[] calldata reply) external;

    function replyOn_worldTileAt(bytes32 messageId, uint32 reply) external;

    function replyOn_adminAdmin(bytes32 messageId, address reply) external;

    function replyOn_adminFinishSession(bytes32 messageId, uint128[] calldata reply) external;

    function replyOn_adminKill(bytes32 messageId) external;

    function replyOn_adminResetMap(bytes32 messageId, uint128[] calldata reply) external;

    function replyOn_adminResourceVmt(bytes32 messageId, address reply) external;

    function replyOn_adminSetResourceVmt(bytes32 messageId, address reply) external;

    function replyOn_adminStartSession(bytes32 messageId, uint128[] calldata reply) external;

    function replyOn_adminUploadMap(bytes32 messageId, uint128[] calldata reply) external;

    function onErrorReply(bytes32 messageId, bytes calldata payload, bytes4 replyCode) external payable;
}

contract DiggerWorldCaller is IDiggerWorldCallbacks {
    IDiggerWorld public immutable VARA_ETH_PROGRAM;

    error UnauthorizedCaller();

    constructor(IDiggerWorld _varaEthProgram) {
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

    function replyOn_worldAgentOf(bytes32 messageId, uint128[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_worldAgents(bytes32 messageId, address[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_worldConfig(bytes32 messageId, uint32[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_worldDrill(bytes32 messageId, uint128[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_worldExit(bytes32 messageId, uint128[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_worldInventoryOf(bytes32 messageId, uint32[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_worldIsDug(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_worldMapSnapshot(bytes32 messageId, uint32[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_worldMintResources(bytes32 messageId, uint128[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_worldMoveAgent(bytes32 messageId, uint128[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_worldPlaceLadder(bytes32 messageId, uint128[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_worldRegister(bytes32 messageId, uint128[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_worldSession(bytes32 messageId, uint128[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_worldSurface(bytes32 messageId, uint128[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_worldTileAt(bytes32 messageId, uint32 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminAdmin(bytes32 messageId, address reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminFinishSession(bytes32 messageId, uint128[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminKill(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminResetMap(bytes32 messageId, uint128[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminResourceVmt(bytes32 messageId, address reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminSetResourceVmt(bytes32 messageId, address reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminStartSession(bytes32 messageId, uint128[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_adminUploadMap(bytes32 messageId, uint128[] calldata reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function onErrorReply(bytes32 messageId, bytes calldata payload, bytes4 replyCode) external payable onlyVaraEthProgram {
        // TODO: implement this
    }
}
