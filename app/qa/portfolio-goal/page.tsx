import { notFound } from 'next/navigation';
import { PortfolioGoalCardFixture } from './PortfolioGoalCardFixture';

export const dynamic = 'force-dynamic';

export default function PortfolioGoalCardFixturePage() {
  if (
    process.env.VERCEL_ENV === 'production'
    || process.env.PORTFOLIO_GOAL_QA_FIXTURE !== '1'
  ) {
    notFound();
  }
  return <PortfolioGoalCardFixture />;
}
