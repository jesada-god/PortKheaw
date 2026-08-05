'use client';

import Image from 'next/image';
import type {
  PortfolioMascotMood,
  PortfolioMascotSpecialEvent,
  PortfolioMascotState,
} from '@/src/lib/portfolio/goal-card';
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

const moodAssets: Record<PortfolioMascotMood, string> = {
  strongGain: '/brand/01_gain_strong.jpg',
  gain: '/brand/02_gain_soft_wink.jpg',
  neutral: '/brand/03_neutral.jpg',
  smallLoss: '/brand/04_loss_soft.jpg',
  loss: '/brand/05_loss_big.jpg',
  heavyLoss: '/brand/06_loss_heavy_cry.jpg',
};

const specialEventAssets: Record<PortfolioMascotSpecialEvent, string> = {
  lossOver50: '/brand/08_event_loss_over_50.jpg',
  gainOver50: '/brand/09_event_gain_over_50.jpg',
  gainOver100: '/brand/07_event_gain_over_100.jpg',
};

export type PortfolioGoalReturnTone = 'positive' | 'negative' | 'neutral';

export function portfolioGoalReturnTone(value: number | null): PortfolioGoalReturnTone {
  if (value === null || !Number.isFinite(value) || value === 0) return 'neutral';
  return value > 0 ? 'positive' : 'negative';
}

export function portfolioGoalReturnToneClass(value: number | null, neutralClass: string): string {
  const tone = portfolioGoalReturnTone(value);
  if (tone === 'positive') return 'text-positive';
  if (tone === 'negative') return 'text-negative';
  return neutralClass;
}

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
    height={1024}
    sizes={compact
      ? '(max-width: 640px) 64px, (max-width: 1024px) 80px, 96px'
      : '(max-width: 640px) 80px, (max-width: 1024px) 96px, 112px'}
    src={portfolioGoalMascotAsset(state)}
    width={1024}
  />;
}
