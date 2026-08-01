import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Watchlist, Notification, PortfolioItem } from '../types';

export type MotionPreference = 'system' | 'reduce' | 'normal';

interface AppState {
  currency: 'THB' | 'USD';
  toggleCurrency: () => void;
  showBalances: boolean;
  toggleBalances: () => void;
  privacyMode: boolean;
  setPrivacyMode: (enabled: boolean) => void;
  dataSaver: boolean;
  setDataSaver: (enabled: boolean) => void;
  motionPreference: MotionPreference;
  setMotionPreference: (preference: MotionPreference) => void;
  
  watchlists: Watchlist[];
  activeWatchlistId: string;
  setActiveWatchlist: (id: string) => void;
  addWatchlist: (name: string) => void;
  addToWatchlist: (listId: string, symbol: string) => void;
  removeFromWatchlist: (listId: string, symbol: string) => void;
  
  favorites: string[];
  toggleFavorite: (symbol: string) => void;
  
  recentSearches: string[];
  addRecentSearch: (query: string) => void;
  clearRecentSearches: () => void;
  
  notifications: Notification[];
  markNotificationRead: (id: string) => void;
  clearNotifications: () => void;
  addNotification: (notif: Omit<Notification, 'id' | 'timestamp'>) => void;

  portfolio: PortfolioItem[];
  addCashRecord: (amount: number, currency: 'THB' | 'USD') => void;
  cashBalance: number;
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      currency: 'THB',
      toggleCurrency: () => set((state) => ({ currency: state.currency === 'THB' ? 'USD' : 'THB' })),
      showBalances: true,
      toggleBalances: () => set((state) => ({ showBalances: !state.showBalances })),
      // Fail closed until persisted device preferences hydrate so portfolio
      // values never flash before a saved privacy preference is restored.
      privacyMode: true,
      setPrivacyMode: (privacyMode) => set({ privacyMode }),
      dataSaver: false,
      setDataSaver: (dataSaver) => set({ dataSaver }),
      motionPreference: 'system',
      setMotionPreference: (motionPreference) => set({ motionPreference }),
      
      watchlists: [
        { id: '1', name: 'รายการโปรด', symbols: ['AAPL', 'NVDA', 'DELTA'] },
        { id: '2', name: 'เทคโนโลยี', symbols: ['AAPL', 'MSFT', 'NVDA'] }
      ],
      activeWatchlistId: '1',
      setActiveWatchlist: (id) => set({ activeWatchlistId: id }),
      addWatchlist: (name) => set((state) => ({
        watchlists: [...state.watchlists, { id: Date.now().toString(), name, symbols: [] }]
      })),
      addToWatchlist: (listId, symbol) => set((state) => ({
        watchlists: state.watchlists.map(w => w.id === listId && !w.symbols.includes(symbol) ? { ...w, symbols: [...w.symbols, symbol] } : w)
      })),
      removeFromWatchlist: (listId, symbol) => set((state) => ({
        watchlists: state.watchlists.map(w => w.id === listId ? { ...w, symbols: w.symbols.filter(s => s !== symbol) } : w)
      })),
      
      favorites: ['AAPL', 'NVDA'],
      toggleFavorite: (symbol) => set((state) => {
        const isFav = state.favorites.includes(symbol);
        const newFavs = isFav ? state.favorites.filter(s => s !== symbol) : [...state.favorites, symbol];
        
        // Also update the 'รายการโปรด' watchlist
        const favWatchlistId = '1';
        const watchlists = state.watchlists.map(w => {
          if (w.id === favWatchlistId) {
            return { ...w, symbols: newFavs };
          }
          return w;
        });

        return { favorites: newFavs, watchlists };
      }),
      
      recentSearches: [],
      addRecentSearch: (query) => set((state) => ({
        recentSearches: [query, ...state.recentSearches.filter(q => q !== query)].slice(0, 5)
      })),
      clearRecentSearches: () => set({ recentSearches: [] }),
      
      notifications: [],
      markNotificationRead: (id) => set((state) => ({
        notifications: state.notifications.map(n => n.id === id ? { ...n, read: true } : n)
      })),
      clearNotifications: () => set({ notifications: [] }),
      addNotification: (notif) => set((state) => ({
        notifications: [{ ...notif, id: Date.now().toString(), timestamp: new Date().toISOString() }, ...state.notifications]
      })),

      portfolio: [],
      cashBalance: 0,
      addCashRecord: (amount, curr) => set((state) => ({
         cashBalance: state.cashBalance + (curr === 'USD' ? amount * 35 : amount)
      }))
    }),
    {
      name: 'nexora-ai-storage',
      skipHydration: true,
      version: 2,
      migrate: (persisted, version) => {
        const state = persisted as Partial<AppState> & { reducedMotion?: boolean };
        if (version < 2 && state.motionPreference === undefined) {
          state.motionPreference = state.reducedMotion ? 'reduce' : 'system';
        }
        delete state.reducedMotion;
        return state as AppState;
      },
    }
  )
);
