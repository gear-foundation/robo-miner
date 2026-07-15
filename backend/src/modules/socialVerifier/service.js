import { normalizeAddress } from '../diggerRental/service.js';
import { parseTweetUrl, normalizeXUsername, badRequest, XVerifierService } from './xService.js';

const VALID_TASK_TYPES = new Set(['repost', 'quote']);

export class SocialVerifierService {
  constructor({
    store,
    config,
    chainFactory = null,
    xVerifier = null,
    now = () => new Date(),
    logger = null,
  }) {
    this.store = store;
    this.config = config;
    this.chainFactory = chainFactory;
    this.xVerifier = xVerifier || new XVerifierService({ config });
    this.now = now;
    this.logger = logger;
  }

  async submitXTask({
    owner,
    taskType,
    tweetUrl,
    xUsername = '',
    seasonId = null,
    diggerProgramId = null,
    dryRun = null,
  }) {
    const normalizedOwner = normalizeAddress(owner);
    const normalizedTaskType = normalizeTaskType(taskType);
    const { tweetId, username: urlUsername } = parseTweetUrl(tweetUrl);
    const submittedUsername = xUsername ? normalizeXUsername(xUsername) : urlUsername;
    const resolvedSeasonId = seasonId || this.config.diggerRentalSeason;
    const weekKey = getUtcWeekKey(this.now());
    const amount = BigInt(this.config.socialFuelGrantAmounts[normalizedTaskType]);
    const resolvedDryRun = dryRun ?? this.config.diggerRentalMode !== 'live';
    const grantId = `social:x:${weekKey}:${normalizedOwner}:${normalizedTaskType}`;
    const reason = `x ${normalizedTaskType} ${weekKey}`;

    await this.ensureNoDuplicate({
      owner: normalizedOwner,
      taskType: normalizedTaskType,
      tweetId,
      weekKey,
      xUsername: submittedUsername,
    });

    const lookup = this.config.socialVerifierMode === 'mock'
      ? mockLookup(tweetId, submittedUsername || 'mockuser', this.config.socialXSourceUsername)
      : await this.xVerifier.fetchTweet(tweetId);
    const verifiedUsername = await this.xVerifier.verifyTask(
      lookup,
      normalizedTaskType,
      submittedUsername || xUsername || urlUsername,
    );

    if (submittedUsername && verifiedUsername !== submittedUsername) {
      await this.ensureNoDuplicate({
        owner: normalizedOwner,
        taskType: normalizedTaskType,
        tweetId,
        weekKey,
        xUsername: verifiedUsername,
      });
    }

    const digger = await this.resolveDigger({
      owner: normalizedOwner,
      seasonId: resolvedSeasonId,
      diggerProgramId,
    });
    const programId = normalizeAddress(digger.programId);
    const now = this.now();
    const submission = {
      id: grantId,
      grantId,
      type: 'x-task',
      owner: normalizedOwner,
      seasonId: resolvedSeasonId,
      taskType: normalizedTaskType,
      tweetUrl,
      tweetId,
      xUsername: verifiedUsername,
      amount: amount.toString(),
      reason,
      diggerId: digger.id || programId,
      programId,
      status: resolvedDryRun ? 'dry-run' : 'approved',
      fuelGrantId: `${grantId}:fuel`,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await this.store.update((db) => {
      if (db.socialRewardSubmissions.some((item) => item.grantId === grantId)) {
        throw conflict('social_reward_already_paid_this_week');
      }
      if (db.socialRewardSubmissions.some((item) => (
        item.taskType === normalizedTaskType
        && item.tweetId === tweetId
        && item.xUsername === verifiedUsername
      ))) {
        throw conflict('x_post_already_paid_for_task');
      }
      if (db.socialRewardSubmissions.some((item) => (
        item.taskType === normalizedTaskType
        && item.weekKey === weekKey
        && item.xUsername === verifiedUsername
      ))) {
        throw conflict('x_account_already_paid_this_week');
      }
      db.socialRewardSubmissions.push({ ...submission, weekKey });
    });

    const grant = await this.grantFuel({
      submission,
      amount,
      dryRun: resolvedDryRun,
    });

    const paidAt = this.now().toISOString();
    await this.store.update((db) => {
      const row = db.socialRewardSubmissions.find((item) => item.grantId === grantId);
      if (row) {
        row.status = grant.status;
        row.txHash = grant.txHash || null;
        row.updatedAt = paidAt;
        row.paidAt = ['confirmed', 'dry-run'].includes(grant.status) ? paidAt : null;
      }
    });

    this.logger?.info?.('social.x.grant', {
      owner: normalizedOwner,
      taskType: normalizedTaskType,
      xUsername: verifiedUsername,
      programId,
      amount: amount.toString(),
      status: grant.status,
      dryRun: resolvedDryRun,
    });

    return {
      ...submission,
      weekKey,
      status: grant.status,
      txHash: grant.txHash || null,
      fuelGrant: grant,
    };
  }

  async listSubmissions({ owner = null, limit = 100 } = {}) {
    const normalizedOwner = owner ? normalizeAddress(owner) : null;
    const db = await this.store.read();
    return db.socialRewardSubmissions
      .filter((item) => !normalizedOwner || item.owner === normalizedOwner)
      .slice(-limit)
      .reverse();
  }

  async ensureNoDuplicate({ owner, taskType, tweetId, weekKey, xUsername }) {
    const db = await this.store.read();
    if (db.socialRewardSubmissions.some((item) => (
      item.owner === owner
      && item.taskType === taskType
      && item.weekKey === weekKey
    ))) {
      throw conflict('wallet_already_paid_for_task_this_week');
    }
    if (xUsername && db.socialRewardSubmissions.some((item) => (
      item.taskType === taskType
      && item.tweetId === tweetId
      && item.xUsername === xUsername
    ))) {
      throw conflict('x_post_already_paid_for_task');
    }
    if (xUsername && db.socialRewardSubmissions.some((item) => (
      item.taskType === taskType
      && item.weekKey === weekKey
      && item.xUsername === xUsername
    ))) {
      throw conflict('x_account_already_paid_this_week');
    }
  }

  async resolveDigger({ owner, seasonId, diggerProgramId }) {
    const db = await this.store.read();
    const requested = diggerProgramId ? normalizeAddress(diggerProgramId) : null;
    const digger = db.diggers.find((item) => (
      item.owner
      && item.programId
      && normalizeAddress(item.owner) === owner
      && (!seasonId || item.seasonId === seasonId)
      && (!requested || normalizeAddress(item.programId) === requested)
      && ['active', 'planned'].includes(item.status)
    ));
    if (!digger) throw badRequest('active_digger_not_found_for_owner');
    return digger;
  }

  async grantFuel({ submission, amount, dryRun }) {
    const programId = normalizeAddress(submission.programId);
    let before = null;
    let txHash = null;
    let status = dryRun ? 'dry-run' : 'pending';
    let updatedAt = this.now().toISOString();

    if (!dryRun) {
      const chain = await this.chainFactory?.();
      try {
        if (!chain?.readExecutableBalance || !chain?.topUpExecutableBalance) {
          throw new Error('Chain client does not support executable balance read/top-up');
        }
        before = BigInt(await chain.readExecutableBalance(programId));
        const receipt = await chain.topUpExecutableBalance(programId, amount);
        txHash = receipt.transactionHash || receipt.hash || null;
        status = receipt.status === 'reverted' || receipt.status === false ? 'failed' : 'confirmed';
        updatedAt = this.now().toISOString();
      } finally {
        await chain?.disconnect?.();
      }
    }

    const now = this.now();
    const grant = {
      id: submission.fuelGrantId,
      idempotencyKey: submission.grantId,
      type: 'social-x',
      seasonId: submission.seasonId,
      diggerId: submission.diggerId,
      programId,
      owner: submission.owner,
      taskType: submission.taskType,
      xUsername: submission.xUsername,
      tweetId: submission.tweetId,
      balanceBefore: before === null ? null : before.toString(),
      amount: amount.toString(),
      txHash,
      status,
      createdAt: now.toISOString(),
      updatedAt,
    };

    await this.store.update((db) => {
      if (!db.fuelGrants.some((item) => item.idempotencyKey === submission.grantId)) {
        db.fuelGrants.push(grant);
      }
      const nextDigger = db.diggers.find((item) => normalizeAddress(item.programId) === programId);
      if (nextDigger && grant.status !== 'failed') {
        delete nextDigger.executableBalance;
        delete nextDigger.executableBalanceObservedAt;
        nextDigger.lastRefuelAt = grant.updatedAt;
        nextDigger.updatedAt = grant.updatedAt;
      }
      db.jobRuns.push({
        id: `social-x:${submission.grantId}:${this.now().toISOString()}`,
        job: 'social-x-fuel-grant',
        mode: dryRun ? 'dry-run' : 'live',
        grantId: submission.grantId,
        programId,
        amount: amount.toString(),
        status: grant.status,
        createdAt: this.now().toISOString(),
      });
    });

    return grant;
  }
}

export function getUtcWeekKey(date = new Date()) {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const day = date.getUTCDay() || 7;
  const monday = new Date(midnight - (day - 1) * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

function normalizeTaskType(value) {
  const taskType = String(value || '').trim().toLowerCase();
  if (!VALID_TASK_TYPES.has(taskType)) throw badRequest('unsupported_task_type');
  return taskType;
}

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function mockLookup(tweetId, username, sourceUsername) {
  const sourceId = 'source';
  return {
    tweet: {
      id: tweetId,
      text: 'Digger Vara agent mining RES campaign',
      author_id: 'author',
      referenced_tweets: [{ type: 'retweeted', id: 'source-tweet' }],
    },
    includedTweets: [{ id: 'source-tweet', author_id: sourceId }],
    includedUsers: [
      { id: 'author', username },
      { id: sourceId, username: String(sourceUsername || 'VaraNetwork').replace(/^@/, '') },
    ],
  };
}
