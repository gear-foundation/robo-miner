const X_USERNAME_RE = /^[a-z0-9_]{1,15}$/;
const X_REPOST_PAGE_LIMIT = 10;

export class XVerifierService {
  constructor({ config, fetchImpl = globalThis.fetch }) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async fetchTweet(tweetId) {
    const token = this.config.socialXBearerToken;
    if (!token) throw badRequest('x_bearer_token_missing');

    const url = new URL(`https://api.x.com/2/tweets/${tweetId}`);
    url.searchParams.set('tweet.fields', 'author_id,conversation_id,created_at,entities,referenced_tweets,text');
    url.searchParams.set('user.fields', 'username');
    url.searchParams.set('expansions', 'author_id,referenced_tweets.id,referenced_tweets.id.author_id');

    const response = await this.fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw badRequest(`x_tweet_lookup_failed:${response.status}:${body.slice(0, 180)}`);
    }

    const json = await response.json();
    if (!json.data) throw badRequest('tweet_not_found');
    return {
      tweet: json.data,
      includedTweets: json.includes?.tweets || [],
      includedUsers: json.includes?.users || [],
    };
  }

  async verifyTask(lookup, taskType, xUsername = '') {
    const refs = lookup.tweet.referenced_tweets || [];

    if (taskType === 'repost') {
      const retweet = refs.find((ref) => ref.type === 'retweeted');
      if (retweet) {
        this.ensureSourcePost(lookup, retweet.id, 'repost');
        return this.resolveTweetAuthorUsername(lookup, xUsername, 'repost');
      }

      this.ensureTweetAuthorIsSource(lookup, 'repost');
      const normalizedUsername = normalizeXUsername(xUsername, 'x_username_required_for_original_post');
      await this.ensureUserRepostedTweet(lookup.tweet.id, normalizedUsername);
      return normalizedUsername;
    }

    if (taskType === 'quote') {
      const quote = refs.find((ref) => ref.type === 'quoted');
      if (quote) {
        this.ensureSourcePost(lookup, quote.id, 'quote');
        const normalizedUsername = this.resolveTweetAuthorUsername(lookup, xUsername, 'quote');
        this.ensureQuoteTextMentionsCampaign(lookup.tweet.text);
        return normalizedUsername;
      }

      const normalizedUsername = this.resolveTweetAuthorUsername(lookup, xUsername, 'post');
      this.ensureStandaloneCampaignPost(lookup.tweet);
      return normalizedUsername;
    }

    throw badRequest('unsupported_task_type');
  }

  ensureSourcePost(lookup, referencedTweetId, label) {
    const username = this.findIncludedTweetAuthorUsername(lookup, referencedTweetId);
    if (username !== this.sourceUsername()) {
      throw badRequest(`${label}_must_target_source_account`);
    }
  }

  ensureTweetAuthorIsSource(lookup, label) {
    const username = this.findTweetAuthorUsername(lookup);
    if (username !== this.sourceUsername()) {
      throw badRequest(`${label}_must_target_source_account`);
    }
  }

  resolveTweetAuthorUsername(lookup, xUsername, label) {
    const username = this.findTweetAuthorUsername(lookup);
    if (!username) throw badRequest(`${label}_author_not_verified`);
    if (xUsername && username !== normalizeXUsername(xUsername)) {
      throw badRequest(`${label}_author_mismatch`);
    }
    return username;
  }

  findTweetAuthorUsername(lookup) {
    const author = lookup.tweet.author_id
      ? lookup.includedUsers.find((user) => user.id === lookup.tweet.author_id)
      : null;
    return author?.username?.toLowerCase();
  }

  findIncludedTweetAuthorUsername(lookup, tweetId) {
    const tweet = lookup.includedTweets.find((item) => item.id === tweetId);
    const author = tweet?.author_id
      ? lookup.includedUsers.find((user) => user.id === tweet.author_id)
      : null;
    return author?.username?.toLowerCase();
  }

  sourceUsername() {
    return normalizeXUsername(this.config.socialXSourceUsername || 'VaraNetwork');
  }

  ensureQuoteTextMentionsCampaign(text) {
    if (!/digger|vara|mining|agent|res/i.test(text || '')) {
      throw badRequest('quote_text_must_mention_campaign');
    }
  }

  ensureStandaloneCampaignPost(tweet) {
    const text = normalizeText(tweet.text || '');
    const hasCampaignText = ['digger', 'vara', 'agent', 'mining', 'res'].some((word) => text.includes(word));
    if (!hasCampaignText) throw badRequest('post_must_mention_campaign');
  }

  async ensureUserRepostedTweet(tweetId, username) {
    if (!(await this.didUserRepostTweet(tweetId, username))) {
      throw badRequest('source_post_not_reposted_by_user');
    }
  }

  async didUserRepostTweet(tweetId, username) {
    const token = this.config.socialXBearerToken;
    if (!token) throw badRequest('x_bearer_token_missing');

    let paginationToken = null;
    for (let page = 0; page < X_REPOST_PAGE_LIMIT; page += 1) {
      const url = new URL(`https://api.x.com/2/tweets/${tweetId}/retweeted_by`);
      url.searchParams.set('user.fields', 'username');
      url.searchParams.set('max_results', '100');
      if (paginationToken) url.searchParams.set('pagination_token', paginationToken);

      const response = await this.fetch(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw badRequest(`x_repost_lookup_failed:${response.status}:${body.slice(0, 180)}`);
      }
      const json = await response.json();
      if ((json.data || []).some((user) => user.username?.toLowerCase() === username)) return true;
      paginationToken = json.meta?.next_token || null;
      if (!paginationToken) break;
    }
    return false;
  }
}

export function parseTweetUrl(tweetUrl) {
  let parsed;
  try {
    parsed = new URL(tweetUrl);
  } catch {
    throw badRequest('tweet_url_invalid');
  }

  const host = parsed.hostname.toLowerCase();
  if (!['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(host)) {
    throw badRequest('tweet_url_must_point_to_x');
  }

  const match = parsed.pathname.match(/\/status(?:es)?\/(\d+)/);
  if (!match) throw badRequest('tweet_url_missing_status_id');
  const username = parsed.pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '').toLowerCase();
  return {
    tweetId: match[1],
    username: username && X_USERNAME_RE.test(username) ? username : '',
  };
}

export function normalizeXUsername(value, message = 'x_username_invalid') {
  const normalized = String(value || '').trim().replace(/^@/, '').toLowerCase();
  if (!X_USERNAME_RE.test(normalized)) throw badRequest(message);
  return normalized;
}

export function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
