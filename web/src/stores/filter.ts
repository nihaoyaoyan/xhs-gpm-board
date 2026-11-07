import dayjs from 'dayjs';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface FilterState {
  shopId: number | null;
  start: string;
  end: string;
  setShopId: (shopId: number) => void;
  setRange: (start: string, end: string) => void;
}

const today = dayjs();
const defaultStart = today.subtract(29, 'day').format('YYYY-MM-DD');
const defaultEnd = today.format('YYYY-MM-DD');

export const useFilterStore = create<FilterState>()(
  persist(
    (set) => ({
      shopId: null,
      start: defaultStart,
      end: defaultEnd,
      setShopId: (shopId) => set({ shopId }),
      setRange: (start, end) => set({ start, end }),
    }),
    {
      name: 'xhs-filter',
      partialize: (state) => ({ shopId: state.shopId }),
    },
  ),
);

export function useRangeParams() {
  const shopId = useFilterStore((state) => state.shopId);
  const start = useFilterStore((state) => state.start);
  const end = useFilterStore((state) => state.end);
  return { shop_id: shopId ?? 0, start, end, enabled: shopId !== null };
}
