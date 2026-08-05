'use client';

import Image from 'next/image';
import type {
  PortfolioMascotMood,
  PortfolioMascotSpecialEvent,
  PortfolioMascotState,
} from '@/src/lib/portfolio/goal-card';
import {
  portfolioReturnTone,
  portfolioReturnToneClass,
  type PortfolioReturnTone,
} from '@/src/lib/portfolio/presentation';
import styles from './PortfolioGoalCard.module.css';

export const portfolioGoalAppearance: Record<PortfolioMascotMood, {
  accent: string;
  soft: string;
  colorLabel: string;
}> = {
  strongGain: {
    accent: '#22C55E',
    soft: 'rgba(34, 197, 94, 0.18)',
    colorLabel: 'เขียวเข้ม',
  },
  gain: {
    accent: '#A3E635',
    soft: 'rgba(163, 230, 53, 0.16)',
    colorLabel: 'เขียวอ่อน',
  },
  neutral: {
    accent: '#FACC15',
    soft: 'rgba(250, 204, 21, 0.16)',
    colorLabel: 'เหลือง',
  },
  smallLoss: {
    accent: '#FB7185',
    soft: 'rgba(251, 113, 133, 0.16)',
    colorLabel: 'ชมพู',
  },
  loss: {
    accent: '#EF4444',
    soft: 'rgba(239, 68, 68, 0.17)',
    colorLabel: 'แดง',
  },
  heavyLoss: {
    accent: '#B91C1C',
    soft: 'rgba(185, 28, 28, 0.19)',
    colorLabel: 'แดงเข้ม',
  },
};

/*
 * PNG, not JPEG: these are drawn over a card gradient, over the Overview
 * surface and over both themes, so the file itself carries the transparency.
 * `scripts/normalize-kheaw-assets.mjs` writes them, and it also normalises
 * Kheaw's body to one width across all nine so an event variant never reads as
 * a shrunken mascot next to an ordinary one.
 */
const moodAssets: Record<PortfolioMascotMood, string> = {
  strongGain: '/brand/01_gain_strong.png',
  gain: '/brand/02_gain_soft_wink.png',
  neutral: '/brand/03_neutral.png',
  smallLoss: '/brand/04_loss_soft.png',
  loss: '/brand/05_loss_big.png',
  heavyLoss: '/brand/06_loss_heavy_cry.png',
};

const specialEventAssets: Record<PortfolioMascotSpecialEvent, string> = {
  lossOver50: '/brand/08_event_loss_over_50.png',
  gainOver50: '/brand/09_event_gain_over_50.png',
  gainOver100: '/brand/07_event_gain_over_100.png',
};

/*
 * The goal card reads the same profit/loss colour mapping as the portfolio
 * summary card. These aliases exist only so the goal card's call sites keep
 * their local name; the decision itself lives in `presentation`.
 */
export type PortfolioGoalReturnTone = PortfolioReturnTone;
export const portfolioGoalReturnTone = portfolioReturnTone;
export const portfolioGoalReturnToneClass = portfolioReturnToneClass;

export function portfolioGoalMascotAsset(state: PortfolioMascotState): string {
  return state.specialEvent
    ? specialEventAssets[state.specialEvent]
    : moodAssets[state.mood];
}

export function PortfolioGoalMascot({
  state,
  compact = false,
}: {
  state: PortfolioMascotState;
  compact?: boolean;
}) {
  const appearance = portfolioGoalAppearance[state.mood];
  const sizes = compact
    ? 'h-16 sm:h-20 lg:h-24'
    : 'h-20 sm:h-24 lg:h-28';
  return <Image
    alt={`น้อง Kheaw สี${appearance.colorLabel} แสดงสถานะพอร์ต`}
    className={`${styles.mascot} ${sizes} aspect-square w-auto object-contain object-center`}
    data-visual-variant={state.specialEvent ?? state.mood}
    height={512}
    sizes={compact
      ? '(max-width: 640px) 64px, (max-width: 1024px) 80px, 96px'
      : '(max-width: 640px) 80px, (max-width: 1024px) 96px, 112px'}
    src={portfolioGoalMascotAsset(state)}
    width={512}
  />;
}
