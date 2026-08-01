'use client';

import Image from 'next/image';
import type { PortfolioTodayMood } from '@/src/lib/portfolio/goal-card';
import styles from './PortfolioGoalCard.module.css';

export const portfolioGoalAppearance: Record<PortfolioTodayMood, {
  accent: string;
  soft: string;
  mascotClass: string;
  colorLabel: string;
}> = {
  'strong-gain': {
    accent: '#22C55E',
    soft: 'rgba(34, 197, 94, 0.18)',
    mascotClass: styles.strongGain,
    colorLabel: 'เขียวเข้ม',
  },
  gain: {
    accent: '#A3E635',
    soft: 'rgba(163, 230, 53, 0.16)',
    mascotClass: styles.gain,
    colorLabel: 'เขียวอ่อน',
  },
  flat: {
    accent: '#FACC15',
    soft: 'rgba(250, 204, 21, 0.16)',
    mascotClass: styles.flat,
    colorLabel: 'เหลือง',
  },
  loss: {
    accent: '#FB7185',
    soft: 'rgba(251, 113, 133, 0.16)',
    mascotClass: styles.loss,
    colorLabel: 'ชมพู',
  },
  'strong-loss': {
    accent: '#EF4444',
    soft: 'rgba(239, 68, 68, 0.17)',
    mascotClass: styles.strongLoss,
    colorLabel: 'แดง',
  },
  'severe-loss': {
    accent: '#B91C1C',
    soft: 'rgba(185, 28, 28, 0.19)',
    mascotClass: styles.severeLoss,
    colorLabel: 'แดงเข้ม',
  },
  unavailable: {
    accent: '#84CC16',
    soft: 'rgba(132, 204, 22, 0.15)',
    mascotClass: styles.unavailable,
    colorLabel: 'เขียว Glossy Tech',
  },
};

export function PortfolioGoalMascot({
  mood,
  compact = false,
}: {
  mood: PortfolioTodayMood;
  compact?: boolean;
}) {
  const appearance = portfolioGoalAppearance[mood];
  const sizes = compact
    ? 'h-16 sm:h-20 lg:h-24'
    : 'h-20 sm:h-24 lg:h-28';
  return <Image
    alt={`น้อง Kheaw สไตล์ Glossy Tech สี${appearance.colorLabel} แสดงสถานะพอร์ตวันนี้`}
    className={`${styles.mascot} ${appearance.mascotClass} ${sizes} w-auto object-contain`}
    height={512}
    sizes={compact
      ? '(max-width: 640px) 64px, (max-width: 1024px) 80px, 96px'
      : '(max-width: 640px) 80px, (max-width: 1024px) 96px, 112px'}
    src="/brand/kheaw-goal-tech.png"
    width={512}
  />;
}
