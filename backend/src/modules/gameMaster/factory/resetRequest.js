export function resetRequestDecision(request, { network, processStartedAtMs = Date.now() } = {}) {
  if (!request || typeof request !== 'object') return { action: 'ignore', reason: 'missing' };
  if (request.network && network && request.network !== network) {
    return { action: 'ignore', reason: 'network_mismatch' };
  }

  const status = String(request.status || '').toLowerCase();
  if (status === 'pending') return { action: 'apply', reason: 'pending' };

  if (status === 'applied') {
    const createdAtMs = resetRequestCreatedAtMs(request);
    if (Number.isFinite(createdAtMs) && createdAtMs >= processStartedAtMs) {
      return { action: 'scrub_and_exit', reason: 'applied_after_process_start' };
    }
  }

  return { action: 'ignore', reason: status || 'unknown_status' };
}

export function resetRequestCreatedAtMs(request) {
  const direct = Date.parse(request?.createdAt || '');
  if (Number.isFinite(direct)) return direct;
  const fromId = String(request?.id || '').match(/admin-testnet-reset:(.+)$/);
  const parsed = Date.parse(fromId?.[1] || '');
  return Number.isFinite(parsed) ? parsed : NaN;
}
