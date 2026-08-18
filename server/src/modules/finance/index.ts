import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { accountsRoutes } from './accounts.routes.ts';
import { fiscalYearRoutes } from './fiscalYears.routes.ts';
import { journalRoutes } from './journal.routes.ts';
import { ledgerRoutes } from './ledger.routes.ts';
import { spendingRoutes } from './spending.routes.ts';
import { paymentRoutes } from './payments.routes.ts';

export const financeRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  await app.register(accountsRoutes);
  await app.register(fiscalYearRoutes);
  await app.register(journalRoutes);
  await app.register(ledgerRoutes);
  await app.register(spendingRoutes);
  await app.register(paymentRoutes);
};
