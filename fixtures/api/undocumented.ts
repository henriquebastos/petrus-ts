// Planted defect: an exported name with no JSDoc line. Even `pnpm lint:api --update` must refuse it.
export const retryLimit: number = 3;
