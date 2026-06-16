export async function createVaraEthChain(config, { logger = null } = {}) {
  if (!config.adminKey) throw new Error('DIGGER_ADMIN_KEY is required for live digger rental top-up');

  const { CodeState, WsVaraEthProvider, createVaraEthApi, getMirrorClient } = await import('@vara-eth/api');
  const { walletClientToSigner } = await import('@vara-eth/api/signer');
  const { generateCodeHash } = await import('@vara-eth/api/util');
  const { createPublicClient, createWalletClient, http, webSocket } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { SailsProgram } = await import('sails-js');
  const { SailsIdlParser } = await import('sails-js/parser');

  const account = privateKeyToAccount(normalizePrivateKey(config.adminKey));
  const transport = config.ethRpc.startsWith('ws') ? webSocket(config.ethRpc) : http(config.ethRpc);
  const publicClient = createPublicClient({ transport });
  const walletClient = createWalletClient({ account, transport });
  const signer = walletClientToSigner(walletClient);
  const api = await createVaraEthApi(new WsVaraEthProvider(config.varaEthWs), publicClient, config.routerAddress, signer);

  return {
    account: account.address,
    async readExecutableBalance(programId) {
      const mirror = mirrorClient(getMirrorClient, programId, publicClient, signer);
      const state = await readProgramState(api, mirror);
      return BigInt(state.executableBalance);
    },
    async topUpExecutableBalance(programId, amount) {
      const topUp = BigInt(amount);
      if (topUp <= 0n) throw new Error(`Top-up amount must be positive, got ${amount}`);

      const balance = await api.eth.wvara.balanceOf(account.address);
      if (BigInt(balance) < topUp) {
        throw new Error(`Not enough WVARA for top-up: need ${topUp}, balance ${balance}`);
      }

      const mirror = mirrorClient(getMirrorClient, programId, publicClient, signer);
      const approveTx = await api.eth.wvara.approve(programId, topUp);
      await sendAndWait(approveTx, 'wVARA approve');
      const topUpTx = await mirror.executableBalanceTopUp(topUp);
      return sendAndWait(topUpTx, 'executableBalanceTopUp');
    },
    async deployDigger({ owner, worldId, codeId, initialTopUp = 0n }) {
      const startedAt = Date.now();
      const topUp = BigInt(initialTopUp);
      logger?.info?.('deploy.start', {
        owner,
        worldId,
        codeId: codeId || null,
        initialTopUp: topUp.toString(),
      });
      logger?.info?.('deploy.code_validation.start', {
        codeId: codeId || null,
        wasmPath: config.diggerProxyWasmPath || null,
      });
      const normalizedCodeId = await ensureProxyCodeValidated({
        api,
        codeId,
        accountAddress: account.address,
        readFile,
        path,
        generateCodeHash,
        CodeState,
        rootDir: config.rootDir,
        wasmPath: config.diggerProxyWasmPath,
        timeoutMs: config.indexerTimeoutMs || 180000,
        logger,
      });
      logger?.info?.('deploy.code_validation.ok', {
        codeId: normalizedCodeId,
        elapsedMs: Date.now() - startedAt,
      });
      const ownerActor = actorIdFromAddress(normalizeAddress(owner, 'owner'));
      const worldActor = actorIdFromAddress(normalizeAddress(worldId, 'worldId'));
      const builder = api.eth.router.createProgramBuilder(normalizedCodeId);
      const createTx = builder.build();
      logger?.info?.('deploy.create_program.start', {
        codeId: normalizedCodeId,
        elapsedMs: Date.now() - startedAt,
      });
      const createReceipt = await createTx.sendAndWaitForReceipt();
      logger?.info?.('deploy.create_program.receipt', {
        txHash: createReceipt.transactionHash || createReceipt.hash || null,
        status: createReceipt.status,
        elapsedMs: Date.now() - startedAt,
      });
      const programId = normalizeAddress(await createTx.getProgramId(), 'ProgramCreated.actorId');
      logger?.info?.('deploy.program_id.resolved', {
        programId,
        elapsedMs: Date.now() - startedAt,
      });

      let topUpReceipt = null;
      if (topUp > 0n) {
        logger?.info?.('deploy.top_up.start', {
          programId,
          amount: topUp.toString(),
          elapsedMs: Date.now() - startedAt,
        });
        topUpReceipt = await topUpProgramExecutableBalance({
          api,
          getMirrorClient,
          publicClient,
          signer,
          account,
          programId,
          amount: topUp,
          logger,
          startedAt,
        });
        logger?.info?.('deploy.top_up.receipt', {
          programId,
          amount: topUp.toString(),
          txHash: topUpReceipt?.transactionHash || topUpReceipt?.hash || null,
          status: topUpReceipt?.status,
          elapsedMs: Date.now() - startedAt,
        });
      }

      logger?.info?.('deploy.idl.load.start', {
        contract: 'digger_proxy',
        elapsedMs: Date.now() - startedAt,
      });
      const sails = await loadSailsContract({ readFile, path, SailsProgram, SailsIdlParser, rootDir: config.rootDir, contract: 'digger_proxy' });
      const createCtor = sails.ctors?.Create;
      if (!createCtor) throw new Error('Proxy IDL does not contain Create constructor');
      logger?.info?.('deploy.idl.load.ok', {
        contract: 'digger_proxy',
        hasCreateCtor: true,
        elapsedMs: Date.now() - startedAt,
      });

      const mirror = mirrorClient(getMirrorClient, programId, publicClient, signer);
      logger?.info?.('deploy.init.encode.start', {
        programId,
        ownerActor,
        worldActor,
        elapsedMs: Date.now() - startedAt,
      });
      const initTx = await mirror.sendMessage(createCtor.encodePayload(ownerActor, worldActor), 0n);
      logger?.info?.('deploy.init.send.start', {
        programId,
        elapsedMs: Date.now() - startedAt,
      });
      const initReceipt = await sendAndWait(initTx, 'DiggerProxy.Create');
      logger?.info?.('deploy.init.receipt', {
        programId,
        txHash: initReceipt.transactionHash || initReceipt.hash || null,
        status: initReceipt.status,
        elapsedMs: Date.now() - startedAt,
      });
      logger?.info?.('deploy.wait_mirror.start', {
        programId,
        timeoutMs: config.indexerTimeoutMs || 180000,
        elapsedMs: Date.now() - startedAt,
      });
      const mirrorState = await waitForMirrorState(api, getMirrorClient, publicClient, signer, programId, { initialized: true }, config.indexerTimeoutMs || 180000);
      logger?.info?.('deploy.wait_mirror.ok', {
        programId,
        stateHash: mirrorState.stateHash || null,
        elapsedMs: Date.now() - startedAt,
      });

      return {
        programId,
        codeId: normalizedCodeId,
        topUp: topUp.toString(),
        createTxHash: createReceipt.transactionHash || createReceipt.hash || null,
        topUpTxHash: topUpReceipt?.transactionHash || topUpReceipt?.hash || null,
        initTxHash: initReceipt.transactionHash || initReceipt.hash || null,
        createStatus: createReceipt.status,
        initStatus: initReceipt.status,
      };
    },
    async depositRedeemReserve(programId, amount) {
      const value = BigInt(amount);
      if (value <= 0n) throw new Error(`Deposit amount must be positive, got ${amount}`);
      const sails = await loadSailsContract({ readFile, path, SailsProgram, SailsIdlParser, rootDir: config.rootDir, contract: 'digger_redeem' });
      const mirror = mirrorClient(getMirrorClient, programId, publicClient, signer);
      const payload = sails.services.Redeem.functions.DepositReserve.encodePayload();
      const tx = await mirror.sendMessage(payload, value);
      return sendAndWait(tx, 'Redeem.DepositReserve');
    },
    async disconnect() {
      await disconnectProvider(api.provider);
      closeViemWebSocket(publicClient);
      closeViemWebSocket(walletClient);
    },
  };
}

async function disconnectProvider(provider) {
  if (!provider?.disconnect) return;
  await Promise.race([
    provider.disconnect(),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]).catch(() => undefined);
}

function closeViemWebSocket(client) {
  const socket = client?.transport?.getSocket?.();
  socket?.close?.();
}

function mirrorClient(getMirrorClient, programId, publicClient, signer) {
  try {
    return getMirrorClient({ address: programId, publicClient, signer });
  } catch {
    return getMirrorClient(programId, { publicClient, signer });
  }
}

async function sendAndWait(tx, label) {
  if (typeof tx.sendAndWaitForReceipt === 'function') return tx.sendAndWaitForReceipt();
  if (typeof tx.send === 'function') {
    const sent = await tx.send();
    if (sent && typeof sent.wait === 'function') return sent.wait();
    if (sent && typeof sent.waitForReceipt === 'function') return sent.waitForReceipt();
    return sent || { status: 'sent', label };
  }
  throw new Error(`${label} transaction object does not expose send method`);
}

async function topUpProgramExecutableBalance({ api, getMirrorClient, publicClient, signer, account, programId, amount, logger = null, startedAt = Date.now() }) {
  const topUp = BigInt(amount);
  const balance = await api.eth.wvara.balanceOf(account.address);
  logger?.info?.('deploy.top_up.balance', {
    programId,
    account: account.address,
    balance: balance.toString(),
    amount: topUp.toString(),
    elapsedMs: Date.now() - startedAt,
  });
  if (BigInt(balance) < topUp) {
    throw new Error(`Not enough WVARA for executable balance top-up: need ${topUp}, balance ${balance}`);
  }

  const mirror = mirrorClient(getMirrorClient, programId, publicClient, signer);
  logger?.info?.('deploy.top_up.approve.start', {
    programId,
    amount: topUp.toString(),
    elapsedMs: Date.now() - startedAt,
  });
  const approveTx = await api.eth.wvara.approve(programId, topUp);
  const approveReceipt = await sendAndWait(approveTx, 'wVARA approve');
  logger?.info?.('deploy.top_up.approve.receipt', {
    programId,
    amount: topUp.toString(),
    txHash: approveReceipt.transactionHash || approveReceipt.hash || null,
    status: approveReceipt.status,
    elapsedMs: Date.now() - startedAt,
  });
  logger?.info?.('deploy.top_up.send.start', {
    programId,
    amount: topUp.toString(),
    elapsedMs: Date.now() - startedAt,
  });
  const topUpTx = await mirror.executableBalanceTopUp(topUp);
  return sendAndWait(topUpTx, 'executableBalanceTopUp');
}

async function waitForMirrorState(api, getMirrorClient, publicClient, signer, programId, expected, timeoutMs) {
  const deadline = Date.now() + Number(timeoutMs || 180000);
  const mirror = mirrorClient(getMirrorClient, programId, publicClient, signer);
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await readMirrorSummary(mirror);
      if (expected.initialized === undefined || last.initialized === expected.initialized) return last;
    } catch (error) {
      last = { error: error.message };
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Timed out waiting for mirror state ${JSON.stringify(expected)} for ${programId}; last=${JSON.stringify(last)}`);
}

async function readMirrorSummary(mirror) {
  const [stateHash, initializer] = await Promise.all([
    callFirst(mirror, ['stateHash', 'getStateHash']),
    callFirst(mirror, ['initializer', 'getInitializer']).catch(() => null),
  ]);
  return {
    stateHash,
    initialized: Boolean(stateHash && !/^0x0{64}$/i.test(String(stateHash))),
    initializer,
  };
}

async function readProgramState(api, mirror) {
  const stateHash = await callFirst(mirror, ['stateHash', 'getStateHash']);
  if (!stateHash || /^0x0{64}$/i.test(String(stateHash))) {
    throw new Error('Program mirror does not have an initialized state hash yet');
  }
  return api.query.program.readState(stateHash);
}

async function callFirst(target, methods) {
  for (const method of methods) {
    if (typeof target[method] !== 'function') continue;
    return target[method]();
  }
  throw new Error(`None of methods exist: ${methods.join(', ')}`);
}

function normalizePrivateKey(value) {
  const key = String(value || '').trim();
  return key.startsWith('0x') ? key : `0x${key}`;
}

function normalizeHex(value, label) {
  const hex = String(value || '').trim();
  const normalized = hex.startsWith('0x') ? hex : `0x${hex}`;
  if (!/^0x[0-9a-fA-F]+$/.test(normalized)) throw new Error(`${label} must be hex`);
  return normalized.toLowerCase();
}

function normalizeHex32(value, label) {
  const hex = normalizeHex(value, label);
  if (hex.length !== 66) throw new Error(`${label} must be 32-byte hex`);
  return hex;
}

function normalizeAddress(value, label) {
  const hex = normalizeHex(value, label);
  if (hex.length === 66) return `0x${hex.slice(-40)}`;
  if (hex.length !== 42) throw new Error(`${label} must be a 20-byte address or 32-byte ActorId`);
  return hex;
}

function actorIdFromAddress(address) {
  return `0x${'00'.repeat(12)}${address.slice(2)}`;
}

async function loadSailsContract({ readFile, path, SailsProgram, SailsIdlParser, rootDir, contract }) {
  const idlPath = path.resolve(rootDir, `../contracts/target/wasm32-gear/release/${contract}.idl`);
  const idl = await readFile(idlPath, 'utf8');
  const parser = typeof SailsIdlParser.new === 'function'
    ? await SailsIdlParser.new()
    : new SailsIdlParser();
  await parser.init?.();
  const sails = typeof SailsProgram.prototype.parseIdl === 'function'
    ? new SailsProgram(parser)
    : new SailsProgram(parser.parse(idl));
  sails.parseIdl?.(idl);
  return sails;
}

async function ensureProxyCodeValidated({
  api,
  codeId,
  accountAddress,
  readFile,
  path,
  generateCodeHash,
  CodeState,
  rootDir,
  wasmPath,
  timeoutMs,
  logger,
}) {
  const artifactPath = wasmPath
    ? path.resolve(rootDir, wasmPath)
    : path.resolve(rootDir, '../contracts/target/wasm32-gear/release/digger_proxy.opt.wasm');

  if (codeId) {
    const resolvedCodeId = normalizeHex32(codeId, 'DIGGER_PROXY_CODE_ID');
    const state = await api.eth.router.codeState(resolvedCodeId);
    logger?.info?.('deploy.code_validation.state', {
      codeId: resolvedCodeId,
      state: String(state),
    });
    if (state === CodeState.Validated) return resolvedCodeId;
    if (state === CodeState.ValidationRequested) {
      logger?.info?.('deploy.code_validation.wait_requested', {
        codeId: resolvedCodeId,
        timeoutMs,
      });
      await waitForCodeState(api, resolvedCodeId, CodeState.Validated, timeoutMs);
      return resolvedCodeId;
    }
  }

  const wasm = await readProxyWasm(readFile, artifactPath, Boolean(codeId));
  const resolvedCodeId = codeId
    ? normalizeHex32(codeId, 'DIGGER_PROXY_CODE_ID')
    : normalizeHex32(generateCodeHash(new Uint8Array(wasm)), 'digger_proxy.opt.wasm code hash');

  const state = await api.eth.router.codeState(resolvedCodeId);
  logger?.info?.('deploy.code_validation.state', {
    codeId: resolvedCodeId,
    state: String(state),
  });
  if (state === CodeState.Validated) return resolvedCodeId;
  if (state === CodeState.ValidationRequested) {
    logger?.info?.('deploy.code_validation.wait_requested', {
      codeId: resolvedCodeId,
      timeoutMs,
    });
    await waitForCodeState(api, resolvedCodeId, CodeState.Validated, timeoutMs);
    return resolvedCodeId;
  }

  const baseFee = await api.eth.router.requestCodeValidationBaseFee();
  const balance = await api.eth.wvara.balanceOf(accountAddress);
  if (BigInt(balance) < BigInt(baseFee)) {
    throw new Error(`Not enough WVARA for code validation: need ${baseFee}, balance ${balance}`);
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
  const { signature } = await api.eth.wvara.prepareAndSignPermitData(api.eth.router.address, baseFee, deadline);
  logger?.info?.('deploy.code_validation.request.start', {
    codeId: resolvedCodeId,
    baseFee: baseFee.toString(),
    deadline: deadline.toString(),
  });
  const tx = await api.eth.router.requestCodeValidation(new Uint8Array(wasm), deadline, signature);
  const receipt = await tx.sendAndWaitForReceipt();
  logger?.info?.('deploy.code_validation.request.receipt', {
    codeId: tx.codeId || resolvedCodeId,
    txHash: receipt.transactionHash || receipt.hash || null,
    status: receipt.status,
  });
  if (receipt.status === 'reverted' || receipt.status === false) {
    throw new Error(`Code validation request failed: ${receipt.transactionHash || receipt.hash || 'unknown tx'}`);
  }
  await waitForCodeState(api, tx.codeId || resolvedCodeId, CodeState.Validated, timeoutMs);
  return normalizeHex32(tx.codeId || resolvedCodeId, 'validated code id');
}

async function readProxyWasm(readFile, wasmPath, hasConfiguredCodeId) {
  try {
    return await readFile(wasmPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const configured = hasConfiguredCodeId
      ? 'Configured DIGGER_PROXY_CODE_ID is not validated yet, so the backend needs the wasm artifact to request validation.'
      : 'Set DIGGER_PROXY_CODE_ID to an already validated code id, or include the wasm artifact in the backend image.';
    throw new Error(`${configured} Missing digger proxy wasm at ${wasmPath}.`);
  }
}

async function waitForCodeState(api, codeId, expected, timeoutMs) {
  const deadline = Date.now() + Number(timeoutMs || 180000);
  let last = null;
  while (Date.now() < deadline) {
    last = await api.eth.router.codeState(codeId);
    if (last === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Timed out waiting for code ${codeId} state ${String(expected)}; current=${String(last)}`);
}
