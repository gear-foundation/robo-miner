export function createFailoverVaraEthProvider(Provider, endpoints, { requestTimeoutMs = 15_000, logger = null } = {}) {
  const urls = [...new Set((endpoints || []).map((value) => String(value || '').trim()).filter(Boolean))];
  if (urls.length === 0) throw new Error('At least one Vara.eth WS endpoint is required');
  const providers = urls.map((url) => new Provider(url, {
    autoConnect: false,
    reconnectAttempts: 1,
    requestTimeout: requestTimeoutMs,
  }));
  let activeIndex = 0;

  const candidates = () => providers.map((_, offset) => {
    const index = (activeIndex + offset) % providers.length;
    return { provider: providers[index], index };
  });

  async function tryProviders(operation, label) {
    let lastError = null;
    for (const { provider, index } of candidates()) {
      try {
        await withTimeoutOrThrow(provider.connect(), requestTimeoutMs, `${label} connect ${urls[index]}`);
        const result = await operation(provider);
        if (activeIndex !== index) logger?.warn?.('rpc.failover', { from: urls[activeIndex], to: urls[index], operation: label });
        activeIndex = index;
        return result;
      } catch (error) {
        if (!isRetryableVaraRpcError(error)) throw error;
        lastError = error;
        logger?.warn?.('rpc.endpoint.failed', { endpoint: urls[index], operation: label, error: error.message });
        await disconnectProvider(provider);
      }
    }
    throw new Error(`${label} failed on all Vara.eth endpoints: ${lastError?.message || 'unknown error'}`);
  }

  return {
    get isConnected() { return providers[activeIndex]?.isConnected || false; },
    get connectionState() { return providers[activeIndex]?.connectionState || 'disconnected'; },
    get url() { return urls[activeIndex]; },
    connect: () => tryProviders(() => undefined, 'Vara.eth WS connect'),
    send: (method, parameters, options) => tryProviders(
      (provider) => provider.send(method, parameters, { ...options, timeout: options?.timeout || requestTimeoutMs }),
      method,
    ),
    subscribe: (method, unsubscribeMethod, parameters, callback) => tryProviders(
      (provider) => provider.subscribe(method, unsubscribeMethod, parameters, callback),
      method,
    ),
    async disconnect() {
      await Promise.all(providers.map((provider) => disconnectProvider(provider)));
    },
  };
}

function isRetryableVaraRpcError(error) {
  const message = String(error?.message || error || '');
  return /timed? out|timeout|websocket|connection|connect after|disconnected|closed unexpectedly|network|econn|socket|fetch failed/i.test(message);
}

export async function createVaraEthChain(config, { logger = null } = {}) {
  if (!config.adminKey) throw new Error('admin key is required for live digger rental top-up (set MAINNET_ADMIN_KEY / TESTNET_ADMIN_KEY)');

  const { CodeState, ReplyCode, WsVaraEthProvider, createVaraEthApi, getMirrorClient } = await import('@vara-eth/api');
  const { walletClientToSigner } = await import('@vara-eth/api/signer');
  const { generateCodeHash } = await import('@vara-eth/api/util');
  const { bytesToHex, createPublicClient, createWalletClient, http, webSocket } = await import('viem');
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
  const varaProvider = createFailoverVaraEthProvider(WsVaraEthProvider, config.varaEthWsEndpoints || [config.varaEthWs], {
    requestTimeoutMs: Number(config.varaEthRequestTimeoutMs || 15_000),
    logger,
  });
  const api = await createVaraEthApi(varaProvider, publicClient, config.routerAddress, signer);

  return {
    account: account.address,
    async readWvaraBalance(address) {
      return BigInt(await api.eth.wvara.balanceOf(normalizeAddress(address, 'WVARA account')));
    },
    async transferWvara(address, amount, { onBroadcast = null } = {}) {
      const recipient = normalizeAddress(address, 'WVARA recipient');
      const value = BigInt(amount);
      if (value <= 0n) throw new Error(`WVARA transfer amount must be positive, got ${amount}`);
      const balance = BigInt(await api.eth.wvara.balanceOf(account.address));
      if (balance < value) throw new Error(`Not enough treasury WVARA: need ${value}, balance ${balance}`);
      const tx = await api.eth.wvara.transfer(recipient, value);
      let receipt;
      let txHash = null;
      if (typeof tx.send === 'function' && typeof tx.getReceipt === 'function') {
        txHash = await tx.send();
        await onBroadcast?.(txHash);
        receipt = await tx.getReceipt();
      } else {
        receipt = await sendAndWait(tx, 'WVARA transfer');
        txHash = receipt?.transactionHash || receipt?.hash || null;
        await onBroadcast?.(txHash);
      }
      return {
        receipt,
        txHash: receipt?.transactionHash || receipt?.hash || txHash,
      };
    },
    async readTransactionReceipt(txHash) {
      try {
        return await publicClient.getTransactionReceipt({ hash: normalizeHex32(txHash, 'transaction hash') });
      } catch (error) {
        if (/not found|could not be found|unknown transaction/i.test(error?.message || '')) return null;
        throw error;
      }
    },
    async readResBalances(programId, owner) {
      const sails = await loadSailsContract({ readFile, path, SailsProgram, SailsIdlParser, rootDir: config.rootDir, contract: 'digger_res_vmt' });
      const query = sails.services.Vmt.queries.BalanceOf;
      const actor = actorIdFromAddress(normalizeAddress(owner, 'RES owner'));
      const [scrst, bcrst, hcrst] = await Promise.all(['0', '1', '2'].map((tokenId) => querySails({
        api,
        accountAddress: account.address,
        programId,
        query,
        args: [actor, tokenId],
        ReplyCode,
        bytesToHex,
        sails,
      })));
      return { scrst: BigInt(scrst), bcrst: BigInt(bcrst), hcrst: BigInt(hcrst) };
    },
    async readRedeemConfig(programId) {
      const sails = await loadSailsContract({ readFile, path, SailsProgram, SailsIdlParser, rootDir: config.rootDir, contract: 'digger_redeem' });
      const queries = sails.services.Redeem.queries;
      const read = (query) => querySails({
        api,
        accountAddress: account.address,
        programId,
        query,
        args: [],
        ReplyCode,
        bytesToHex,
        sails,
      });
      const [varaUnit, scrst, bcrst, hcrst] = await Promise.all([
        read(queries.VaraUnit),
        read(queries.ScrstRate),
        read(queries.BcrstRate),
        read(queries.HcrstRate),
      ]);
      return {
        varaUnit: BigInt(varaUnit),
        rates: { scrst: BigInt(scrst), bcrst: BigInt(bcrst), hcrst: BigInt(hcrst) },
      };
    },
    async readBackendRedeemStatus(programId, requestId) {
      const sails = await loadSailsContract({ readFile, path, SailsProgram, SailsIdlParser, rootDir: config.rootDir, contract: 'digger_redeem' });
      const result = await querySails({
        api,
        accountAddress: account.address,
        programId,
        query: sails.services.Redeem.queries.BackendRequestStatus,
        args: [normalizeHex32(requestId, 'redeem request id')],
        ReplyCode,
        bytesToHex,
        sails,
      });
      return BigInt(result);
    },
    async requestBackendRedeem({ programId, requestId, owner, scrst, bcrst, hcrst, timeoutMs = 180000 }) {
      const sails = await loadSailsContract({ readFile, path, SailsProgram, SailsIdlParser, rootDir: config.rootDir, contract: 'digger_redeem' });
      const normalizedRequestId = normalizeHex32(requestId, 'redeem request id');
      const existing = await querySails({
        api,
        accountAddress: account.address,
        programId,
        query: sails.services.Redeem.queries.BackendRequestStatus,
        args: [normalizedRequestId],
        ReplyCode,
        bytesToHex,
        sails,
      });
      let txHash = null;
      if (BigInt(existing) === 0n) {
        const payload = sails.services.Redeem.functions.RedeemFor.encodePayload(
          normalizedRequestId,
          actorIdFromAddress(normalizeAddress(owner, 'redeem beneficiary')),
          BigInt(scrst).toString(),
          BigInt(bcrst).toString(),
          BigInt(hcrst).toString(),
        );
        const mirror = mirrorClient(getMirrorClient, programId, publicClient, signer);
        const result = await sendMirrorMessageAndWaitForReceipt({
          mirror,
          payload,
          value: 0n,
          label: 'Redeem.RedeemFor',
          logger,
          programId,
        });
        txHash = result.receipt?.transactionHash || result.receipt?.hash || result.txHash || null;
      }
      const deadline = Date.now() + Number(timeoutMs);
      while (Date.now() < deadline) {
        const status = BigInt(await querySails({
          api,
          accountAddress: account.address,
          programId,
          query: sails.services.Redeem.queries.BackendRequestStatus,
          args: [normalizedRequestId],
          ReplyCode,
          bytesToHex,
          sails,
        }));
        if (status === 2n) return { status, txHash };
        if (status === 3n) throw new Error(`Redeem burn was canceled for request ${normalizedRequestId}`);
        await delay(1_000);
      }
      throw new Error(`Timed out waiting for RES burn confirmation for request ${normalizedRequestId}`);
    },
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
    async deployDigger({ owner, worldId, codeId, initialTopUp = 0n, onProgress = null }) {
      const startedAt = Date.now();
      const topUp = BigInt(initialTopUp);
      const reportProgress = async (progress) => {
        try {
          await onProgress?.(progress);
        } catch (error) {
          logger?.error?.('deploy.progress.persist_failed', { ...progress, error: error.message });
        }
      };
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
      let builder = api.eth.router.createProgramBuilder(normalizedCodeId);
      let topUpReceipt = null;
      if (topUp > 0n) {
        logger?.info?.('deploy.create_program.balance.start', {
          amount: topUp.toString(),
          elapsedMs: Date.now() - startedAt,
        });
        const balance = await api.eth.wvara.balanceOf(account.address);
        logger?.info?.('deploy.create_program.balance', {
          account: account.address,
          balance: balance.toString(),
          amount: topUp.toString(),
          elapsedMs: Date.now() - startedAt,
        });
        if (BigInt(balance) < topUp) {
          throw new Error(`Not enough WVARA for initial executable balance: need ${topUp}, balance ${balance}`);
        }
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
        const { signature } = await api.eth.wvara.prepareAndSignPermitData(api.eth.router.address, topUp, deadline);
        builder = builder.withExecutableBalance(topUp, deadline, signature);
        logger?.info?.('deploy.create_program.balance.permit_ok', {
          amount: topUp.toString(),
          deadline: deadline.toString(),
          elapsedMs: Date.now() - startedAt,
        });
      }
      const createTx = builder.build();
      logger?.info?.('deploy.create_program.start', {
        codeId: normalizedCodeId,
        initialExecutableBalance: topUp.toString(),
        elapsedMs: Date.now() - startedAt,
      });
      const receiptTimeoutMs = Number(config.diggerDeployReceiptTimeoutMs || 120_000);
      const createTxHash = typeof createTx.send === 'function'
        ? await withTimeoutOrThrow(createTx.send(), receiptTimeoutMs, 'create program broadcast')
        : null;
      await reportProgress({ stage: 'create_broadcast', createTxHash });
      const createReceipt = typeof createTx.getReceipt === 'function'
        ? await withTimeoutOrThrow(createTx.getReceipt(), receiptTimeoutMs, 'create program receipt')
        : await withTimeoutOrThrow(createTx.sendAndWaitForReceipt(), receiptTimeoutMs, 'create program receipt');
      if (topUp > 0n) topUpReceipt = createReceipt;
      logger?.info?.('deploy.create_program.receipt', {
        txHash: createReceipt.transactionHash || createReceipt.hash || null,
        status: createReceipt.status,
        initialExecutableBalance: topUp.toString(),
        elapsedMs: Date.now() - startedAt,
      });
      const programId = normalizeAddress(await createTx.getProgramId(), 'ProgramCreated.actorId');
      await reportProgress({ stage: 'create_confirmed', createTxHash: createReceipt.transactionHash || createReceipt.hash || createTxHash, programId });
      logger?.info?.('deploy.program_id.resolved', {
        programId,
        elapsedMs: Date.now() - startedAt,
      });

      logger?.info?.('deploy.wait_created_mirror.skipped', {
        programId,
        reason: 'fast_digger_deploy',
        elapsedMs: Date.now() - startedAt,
      });

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
      const initPayload = createCtor.encodePayload(ownerActor, worldActor);
      const initResult = await sendMirrorMessageAndWaitForReceipt({
        mirror,
        payload: initPayload,
        value: 0n,
        label: 'DiggerProxy.Create',
        logger,
        programId,
        startedAt,
        timeoutMs: receiptTimeoutMs,
        onBroadcast: async (initTxHash) => reportProgress({ stage: 'init_broadcast', programId, initTxHash }),
      });
      logger?.info?.('deploy.wait_mirror.skipped', {
        programId,
        reason: 'fast_digger_deploy',
        elapsedMs: Date.now() - startedAt,
      });

      return {
        programId,
        codeId: normalizedCodeId,
        topUp: topUp.toString(),
        createTxHash: createReceipt.transactionHash || createReceipt.hash || createTxHash || null,
        topUpTxHash: topUpReceipt?.transactionHash || topUpReceipt?.hash || null,
        initTxHash: initResult.receipt.transactionHash || initResult.receipt.hash || initResult.txHash || null,
        createStatus: createReceipt.status,
        initStatus: initResult.receipt.status,
      };
    },
    async verifyDiggerReady({ programId, owner, worldId }) {
      const sails = await loadSailsContract({ readFile, path, SailsProgram, SailsIdlParser, rootDir: config.rootDir, contract: 'digger_proxy' });
      return verifyDiggerReady({
        api,
        accountAddress: account.address,
        programId,
        owner,
        worldId,
        sails,
        ReplyCode,
        bytesToHex,
        timeoutMs: Number(config.indexerTimeoutMs || 180000),
        logger,
      });
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

async function querySails({ api, accountAddress, programId, query, args, ReplyCode, bytesToHex, sails }) {
  const payload = query.encodePayload(...args);
  const response = await api.provider.send('program_calculateReplyForHandle', [
    null,
    accountAddress,
    normalizeAddress(programId, 'program id'),
    payload,
    0n,
  ]);
  const reply = response.reply || response;
  assertSuccessReply(reply.replyCode || reply.code, { ReplyCode, bytesToHex, sails, payload: reply.payload });
  if (!reply.payload) throw new Error('program state query returned no payload');
  return query.decodeResult(reply.payload);
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

export async function verifyDiggerReady({
  api,
  accountAddress,
  programId,
  owner,
  worldId,
  sails,
  ReplyCode,
  bytesToHex,
  timeoutMs = 180000,
  logger = null,
  now = Date.now,
  delayFn = delay,
}) {
  const expectedOwner = actorIdFromAddress(normalizeAddress(owner, 'owner')).toLowerCase();
  const expectedWorld = actorIdFromAddress(normalizeAddress(worldId, 'worldId')).toLowerCase();
  const deadline = now() + timeoutMs;
  let lastError = null;
  while (now() < deadline) {
    try {
      const queryTimeoutMs = Math.max(1, Math.min(10_000, deadline - now()));
      const [ownerReply, worldReply] = await Promise.all([
        withTimeout(api.call.program.calculateReplyForHandle(accountAddress, programId, sails.services.Digger.queries.Owner.encodePayload(), 0n), queryTimeoutMs, 'Digger.Owner readiness query'),
        withTimeout(api.call.program.calculateReplyForHandle(accountAddress, programId, sails.services.Digger.queries.World.encodePayload(), 0n), queryTimeoutMs, 'Digger.World readiness query'),
      ]);
      if (!ownerReply || !worldReply) throw new Error('DiggerProxy readiness query timed out');
      assertSuccessReply(ownerReply.replyCode || ownerReply.code, { ReplyCode, bytesToHex, sails, payload: ownerReply.payload });
      assertSuccessReply(worldReply.replyCode || worldReply.code, { ReplyCode, bytesToHex, sails, payload: worldReply.payload });
      const actualOwner = actorIdValueToHex(sails.services.Digger.queries.Owner.decodeResult(ownerReply.payload), bytesToHex);
      const actualWorld = actorIdValueToHex(sails.services.Digger.queries.World.decodeResult(worldReply.payload), bytesToHex);
      if (actualOwner === expectedOwner && actualWorld === expectedWorld) {
        logger?.info?.('deploy.ready', { programId, owner: actualOwner, worldId: actualWorld });
        return { programId, owner: actualOwner, worldId: actualWorld };
      }
      lastError = new Error(`DiggerProxy state mismatch: owner=${actualOwner}, world=${actualWorld}`);
    } catch (error) {
      lastError = error;
    }
    await delayFn(1000);
  }
  throw new Error(`DiggerProxy ${programId} did not become owner/world-ready within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

export function actorIdValueToHex(value, bytesToHex) {
  if (value instanceof Uint8Array) return bytesToHex(value).toLowerCase();
  if (Array.isArray(value)) return bytesToHex(Uint8Array.from(value.map(Number))).toLowerCase();
  if (typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  throw new Error('DiggerProxy query did not return a 32-byte ActorId');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function sendMirrorMessageAndWaitForReceipt({
  mirror,
  payload,
  value,
  label,
  logger = null,
  programId,
  startedAt = Date.now(),
  timeoutMs = 120_000,
  onBroadcast = null,
}) {
  const tx = await mirror.sendMessage(payload, value);
  logger?.info?.('deploy.init.send.start', {
    programId,
    payloadBytes: payloadBytes(payload),
    value: value.toString(),
    elapsedMs: Date.now() - startedAt,
  });

  const txHash = typeof tx.send === 'function'
    ? await withTimeoutOrThrow(tx.send(), timeoutMs, `${label} broadcast`)
    : null;
  await onBroadcast?.(txHash);
  const receipt = typeof tx.getReceipt === 'function'
    ? await withTimeoutOrThrow(tx.getReceipt(), timeoutMs, `${label} receipt`)
    : await withTimeoutOrThrow(sendAndWait(tx, label), timeoutMs, `${label} receipt`);
  const message = typeof tx.getMessage === 'function' ? await tx.getMessage() : null;
  logger?.info?.('deploy.init.receipt', {
    programId,
    txHash: receipt.transactionHash || receipt.hash || txHash || null,
    status: receipt.status,
    blockNumber: stringifyMaybe(receipt.blockNumber),
    messageId: message?.id || null,
    elapsedMs: Date.now() - startedAt,
  });
  logger?.info?.('deploy.init.reply.skipped', {
    programId,
    reason: 'fast_digger_deploy',
    messageId: message?.id || null,
    elapsedMs: Date.now() - startedAt,
  });
  return { receipt, txHash, reply: null };
}

async function sendMirrorMessageAndWaitForReply({
  mirror,
  payload,
  value,
  label,
  sails,
  ReplyCode,
  bytesToHex,
  timeoutMs,
  logger = null,
  programId,
  startedAt = Date.now(),
}) {
  const previousStateHash = await callFirst(mirror, ['stateHash', 'getStateHash']).catch(() => null);
  const tx = await mirror.sendMessage(payload, value);
  logger?.info?.('deploy.init.send.start', {
    programId,
    payloadBytes: payloadBytes(payload),
    value: value.toString(),
    previousStateHash,
    elapsedMs: Date.now() - startedAt,
  });

  const txHash = typeof tx.send === 'function' ? await tx.send() : null;
  const receipt = typeof tx.getReceipt === 'function'
    ? await tx.getReceipt()
    : await sendAndWait(tx, label);
  const message = typeof tx.getMessage === 'function' ? await tx.getMessage() : null;
  logger?.info?.('deploy.init.receipt', {
    programId,
    txHash: receipt.transactionHash || receipt.hash || txHash || null,
    status: receipt.status,
    blockNumber: stringifyMaybe(receipt.blockNumber),
    messageId: message?.id || null,
    elapsedMs: Date.now() - startedAt,
  });

  if (!message?.id || typeof mirror.waitForReply !== 'function') {
    logger?.warn?.('deploy.init.reply.skipped', {
      programId,
      reason: !message?.id ? 'missing_message_id' : 'waitForReply_unavailable',
      elapsedMs: Date.now() - startedAt,
    });
    return { receipt, txHash, reply: null, previousStateHash };
  }

  logger?.info?.('deploy.init.reply.wait_start', {
    programId,
    messageId: message.id,
    blockNumber: stringifyMaybe(receipt.blockNumber),
    timeoutMs,
    elapsedMs: Date.now() - startedAt,
  });
  const reply = await withTimeout(
    mirror.waitForReply(message.id, receipt.blockNumber),
    timeoutMs,
    `${label} mirror reply`,
  );

  if (!reply) {
    logger?.warn?.('deploy.init.reply.timeout', {
      programId,
      messageId: message.id,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
    });
    return { receipt, txHash, reply: null, previousStateHash };
  }

  const replyCode = reply.replyCode || reply.code;
  logger?.info?.('deploy.init.reply.received', {
    programId,
    messageId: message.id,
    txHash: reply.txHash || null,
    blockNumber: stringifyMaybe(reply.blockNumber),
    code: normalizeReplyCode(replyCode, ReplyCode, bytesToHex),
    reason: replyReason(replyCode, ReplyCode),
    value: stringifyMaybe(reply.value),
    payloadBytes: payloadBytes(reply.payload),
    elapsedMs: Date.now() - startedAt,
  });
  assertSuccessReply(replyCode, { ReplyCode, bytesToHex, sails, payload: reply.payload });
  return { receipt, txHash, reply, previousStateHash };
}

async function withTimeout(promise, timeoutMs, label) {
  let timeout = null;
  const timeoutPromise = new Promise((resolve) => {
    timeout = setTimeout(() => {
      resolve(null);
    }, Number(timeoutMs || 180000));
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withTimeoutOrThrow(promise, timeoutMs, label) {
  const result = await withTimeout(promise, timeoutMs, label);
  if (result === null) throw new Error(`${label} timed out after ${Number(timeoutMs || 180000)}ms`);
  return result;
}

function assertSuccessReply(code, { ReplyCode, bytesToHex, sails, payload } = {}) {
  if (!code) throw new Error('program reply did not include reply code');
  const replyCode = parseReplyCode(code, ReplyCode);
  if (replyCode?.isSuccess === true) return;
  if (!replyCode && String(code).toLowerCase().startsWith('0x00')) return;
  throw new Error(`program reply failed: ${normalizeReplyCode(code, ReplyCode, bytesToHex)} (${replyReason(code, ReplyCode)})${decodeErrorPayload(sails, payload)}`);
}

function parseReplyCode(code, ReplyCode) {
  if (!code || typeof code === 'string') {
    try {
      return code && ReplyCode?.fromBytes?.(code);
    } catch {
      return null;
    }
  }
  return code;
}

function normalizeReplyCode(code, ReplyCode, bytesToHex) {
  if (!code) return null;
  if (typeof code === 'string') return code;
  if (typeof code.toBytes === 'function') return bytesToHex(code.toBytes());
  const parsed = parseReplyCode(code, ReplyCode);
  if (parsed && parsed !== code && typeof parsed.toBytes === 'function') return bytesToHex(parsed.toBytes());
  return String(code);
}

function replyReason(code, ReplyCode) {
  const replyCode = parseReplyCode(code, ReplyCode);
  return replyCode?.reason === undefined ? null : String(replyCode.reason);
}

function decodeErrorPayload(sails, payload) {
  if (!sails || !payload || payload === '0x') return '';
  try {
    return `; decoded=${JSON.stringify(sails.decodeError(payload), jsonBigIntReplacer)}`;
  } catch {
    return '';
  }
}

function payloadBytes(payload) {
  return typeof payload === 'string' && payload.startsWith('0x') ? (payload.length - 2) / 2 : 0;
}

function stringifyMaybe(value) {
  return typeof value === 'bigint' ? value.toString() : value ?? null;
}

function jsonBigIntReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
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
      last = await readMirrorStateSummary(api, mirror);
      if (expected.initialized === undefined || last.initialized === expected.initialized) return last;
    } catch (error) {
      last = { error: error.message };
    }
    await sleep(3000);
  }
  throw new Error(`Timed out waiting for mirror state ${JSON.stringify(expected)} for ${programId}; last=${JSON.stringify(last)}`);
}

async function readMirrorStateSummary(api, mirror) {
  const [stateHash, initializer] = await Promise.all([
    callFirst(mirror, ['stateHash', 'getStateHash']),
    callFirst(mirror, ['initializer', 'getInitializer']).catch(() => null),
  ]);
  if (!stateHash || /^0x0{64}$/i.test(String(stateHash))) {
    throw new Error(`Program mirror does not have a visible state hash yet; initializer=${initializer || null}`);
  }
  const state = await api.query.program.readState(stateHash);
  const active = state?.program && Object.prototype.hasOwnProperty.call(state.program, 'Active')
    ? state.program.Active
    : null;
  return {
    stateHash,
    program: active ? 'Active' : Object.keys(state?.program || {})[0] || null,
    initialized: active?.initialized ?? null,
    initializer,
    balance: stringifyMaybe(state?.balance),
    executableBalance: stringifyMaybe(state?.executableBalance),
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
    await sleep(3000);
  }
  throw new Error(`Timed out waiting for code ${codeId} state ${String(expected)}; current=${String(last)}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
