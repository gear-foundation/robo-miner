# Backend Pre-Merge Checklist

## Required

- `npm run scheduler -- --once` passes in `backend`.
- `npm run build` passes in `frontend`.
- `ADMIN_API_TOKEN` is set for any non-local live API.
- `DIGGER_DAILY_EXEC_TARGET=120000000000000`.
- Redeem rate config is `VARA_UNIT=1000000000000`, `SCRST_RATE=6`, `BCRST_RATE=30`, `HCRST_RATE=150`.
- `DIGGER_RENTAL_MODE` is intentionally `dry-run` or `live`.
- `DIGGER_PROXY_CODE_ID` is set before live rental deploys.
- `VITE_BACKEND_URL` points frontend builds to the backend API when chain mode is enabled.

## Live Smoke

1. Start backend API.
2. Request a digger with `dryRun=false`.
3. Verify response includes `programId`, `createTxHash`, `topUpTxHash`, and `initTxHash`.
4. Run scheduler once.
5. Verify rental top-up skips when executable balance is already at or above 120 VARA.
6. Check `/api/admin/overview` and `/api/admin/rental/fuel-grants`.

## Deferred

LP Bonus is intentionally not implemented or scheduled in this MVP.
