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
 * Kheaw at his laptop, for a portfolio that holds nothing yet.
 *
 * The laptop is drawn across his body, so the export could not be normalised
 * the way the other nine are — the opaque silhouette is body-plus-laptop and
 * measuring it would have shipped Kheaw at 81% of his usual size. The build
 * script measures this one by colour instead; see `normalize-kheaw-assets.mjs`.
 */
const EMPTY_PORTFOLIO_ASSET = '/brand/10_empty_laptop.png';

/*
 * The goal card reads the same profit/loss colour mapping as the portfolio
 * summary card. These aliases exist only so the goal card's call sites keep
 * their local name; the decision itself lives in `presentation`.
 */
export type PortfolioGoalReturnTone = PortfolioReturnTone;
export const portfolioGoalReturnTone = portfolioReturnTone;
export const portfolioGoalReturnToneClass = portfolioReturnToneClass;

export function portfolioGoalMascotAsset(state: PortfolioMascotState): string {
  if (state.emptyPortfolio) return EMPTY_PORTFOLIO_ASSET;
  return state.specialEvent
    ? specialEventAssets[state.specialEvent]
    : moodAssets[state.mood];
}

export type PortfolioGoalMascotSize = 'compact' | 'default' | 'hero';

/*
 * Three boxes, and every mood is drawn in whichever one its surface uses — the
 * artwork carries the body scale, normalised at export, so no variant is ever
 * corrected for here. A prop cannot make one Kheaw smaller than another.
 *
 * `hero` is not a bigger Kheaw. It is a bigger box, used only where Kheaw is
 * the whole of what a surface is showing: on an empty portfolio there are no
 * figures beside him, and at 112px in a 366px-wide card with nothing else in it
 * he read as an icon for a message rather than as the message.
 */
const MASCOT_BOX: Record<PortfolioGoalMascotSize, string> = {
  compact: 'h-16 sm:h-20 lg:h-24',
  default: 'h-28 sm:h-36 lg:h-44',
  hero: 'h-36 sm:h-44 lg:h-48',
};

const MASCOT_SIZES: Record<PortfolioGoalMascotSize, string> = {
  compact: '(max-width: 640px) 64px, (max-width: 1024px) 80px, 96px',
  default: '(max-width: 640px) 112px, (max-width: 1024px) 144px, 176px',
  hero: '(max-width: 640px) 144px, (max-width: 1024px) 176px, 192px',
};

export function PortfolioGoalMascot({
  state,
  compact = false,
  size,
}: {
  state: PortfolioMascotState;
  /** Kept for the Overview tile, where Kheaw is one tile among several. */
  compact?: boolean;
  size?: PortfolioGoalMascotSize;
}) {
  const appearance = portfolioGoalAppearance[state.mood];
  const box = size ?? (compact ? 'compact' : 'default');
  const sizes = MASCOT_BOX[box];
  return <Image
    alt={state.emptyPortfolio
      ? 'น้อง Kheaw กับโน้ตบุ๊ก รอสินทรัพย์ชิ้นแรกในพอร์ต'
      : `น้อง Kheaw สี${appearance.colorLabel} แสดงสถานะพอร์ต`}
    className={`${styles.mascot} ${sizes} aspect-square w-auto max-w-full object-contain object-center`}
    data-visual-variant={state.emptyPortfolio ? 'emptyPortfolio' : state.specialEvent ?? state.mood}
    height={512}
    sizes={MASCOT_SIZES[box]}
    src={portfolioGoalMascotAsset(state)}
    width={512}
  />;
}
