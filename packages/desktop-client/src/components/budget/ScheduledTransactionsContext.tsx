import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { send } from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import { computeSchedulePreviewTransactions } from '@actual-app/core/shared/schedules';
import { ungroupTransactions } from '@actual-app/core/shared/transactions';
import type { TransactionEntity } from '@actual-app/core/types/models';

import { useCachedSchedules } from '#hooks/useCachedSchedules';
import { useCategories } from '#hooks/useCategories';
import { useLocalPref } from '#hooks/useLocalPref';
import { useSyncedPref } from '#hooks/useSyncedPref';

type ScheduledTransactionsContextType = {
  showScheduled: boolean;
  setShowScheduled: (val: boolean) => void;
  adjustValue: (
    bindingName: string,
    sheetName: string,
    currentValue: number,
  ) => { value: number; affected: boolean };
};

const ScheduledTransactionsContext =
  createContext<ScheduledTransactionsContextType>({
    showScheduled: false,
    setShowScheduled: () => {
      // noop
    },
    adjustValue: (_, __, val) => ({ value: val, affected: false }),
  });

export function ScheduledTransactionsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [showScheduledPref, setShowScheduledPref] = useLocalPref(
    'budget.showScheduledTransactions',
  );
  const showScheduled = !!showScheduledPref;

  const setShowScheduled = (val: boolean) => {
    setShowScheduledPref(val);
  };

  const { data: categoriesData } = useCategories();
  const categories = categoriesData?.list || [];

  const {
    schedules = [],
    statuses = new Map(),
    isLoading: isSchedulesLoading,
  } = useCachedSchedules();
  const [upcomingLength] = useSyncedPref('upcomingScheduledTransactionLength');
  const [previewTransactions, setPreviewTransactions] = useState<
    TransactionEntity[]
  >([]);
  const [unflattenedPreviews, setUnflattenedPreviews] = useState<
    TransactionEntity[]
  >([]);

  const scheduleTransactions = useMemo(() => {
    if (isSchedulesLoading) return [];
    const preview = computeSchedulePreviewTransactions(
      schedules,
      statuses,
      upcomingLength,
    );
    return preview;
  }, [isSchedulesLoading, schedules, statuses, upcomingLength]);

  useEffect(() => {
    let isUnmounted = false;
    if (scheduleTransactions.length === 0) {
      setPreviewTransactions([]);
      setUnflattenedPreviews([]);
      return;
    }

    Promise.all(
      scheduleTransactions.map(transaction =>
        send('rules-run', { transaction }),
      ),
    )
      .then(newTrans => {
        if (!isUnmounted) {
          const withDefaults = newTrans.map(t => ({
            ...t,
            category: t.category,
            schedule: t.schedule,
            subtransactions: t.subtransactions?.map(
              (st: TransactionEntity) => ({
                ...st,
                id: 'preview/' + st.id,
                schedule: t.schedule,
              }),
            ),
          }));

          // 1. Filter out income (amount > 0 or categorized under income category)
          const paymentsOnly = withDefaults.filter(t => {
            if (t.amount > 0) return false;
            if (t.category) {
              const cat = categories.find(c => c.id === t.category);
              if (cat?.is_income) return false;
            }
            return true;
          });

          // 2. Sort by date ascending to get next occurrence first
          const sorted = [...paymentsOnly].sort((a, b) =>
            a.date.localeCompare(b.date),
          );

          // 3. Keep only the next occurrence for each schedule ID
          const processedSchedules = new Set<string>();
          const nextOccurrences = sorted.filter(t => {
            if (t.schedule) {
              if (processedSchedules.has(t.schedule)) {
                return false;
              }
              processedSchedules.add(t.schedule);
            }
            return true;
          });

          setUnflattenedPreviews(nextOccurrences);
          setPreviewTransactions(ungroupTransactions(nextOccurrences));
        }
      })
      .catch(err => {
        console.error('[ScheduledTransactions] Error running rules on preview transactions:', err);
      });

    return () => {
      isUnmounted = true;
    };
  }, [scheduleTransactions, statuses, categories]);

  const adjustments = useMemo(() => {
    const map: Record<
      string,
      Record<string, { spent: number; affected: boolean }>
    > = {};

    const getMonthMap = (m: string) => {
      if (!map[m]) map[m] = {};
      return map[m];
    };

    const getCategoryData = (m: string, catId: string) => {
      const monthMap = getMonthMap(m);
      if (!monthMap[catId]) {
        monthMap[catId] = { spent: 0, affected: false };
      }
      return monthMap[catId];
    };

    const processTransaction = (t: TransactionEntity) => {
      if (t.subtransactions && t.subtransactions.length > 0) {
        for (const st of t.subtransactions) {
          processTransaction(st);
        }
      } else {
        if (t.category && t.date) {
          const m = monthUtils.getMonth(t.date);
          const catData = getCategoryData(m, t.category);
          catData.spent += t.amount || 0;
          catData.affected = true;
        }
      }
    };

    if (unflattenedPreviews) {
      for (const t of unflattenedPreviews) {
        processTransaction(t);
      }
    }

    return map;
  }, [previewTransactions, unflattenedPreviews]);

  const adjustValue = (
    bindingName: string,
    sheetName: string,
    currentValue: number,
  ) => {
    const defaultValue = { value: currentValue, affected: false };
    if (!showScheduled) return defaultValue;

    const month = sheetName?.startsWith('budget')
      ? sheetName.slice(6, 10) + '-' + sheetName.slice(10, 12)
      : null;

    if (!month || !adjustments[month]) return defaultValue;

    const monthAdjustments = adjustments[month];

    if (bindingName.startsWith('sum-amount-')) {
      const categoryId = bindingName.slice(11);
      const adj = monthAdjustments[categoryId];
      if (adj) {
        return { value: currentValue + adj.spent, affected: adj.affected };
      }
    } else if (bindingName.startsWith('leftover-')) {
      const categoryId = bindingName.slice(9);
      const adj = monthAdjustments[categoryId];
      if (adj) {
        return { value: currentValue + adj.spent, affected: adj.affected };
      }
    } else if (bindingName.startsWith('group-sum-amount-')) {
      const groupId = bindingName.slice(17);
      const groupCategories = categories.filter(c => c.group === groupId);
      let spent = 0;
      let affected = false;
      for (const c of groupCategories) {
        const adj = monthAdjustments[c.id];
        if (adj) {
          spent += adj.spent;
          if (adj.affected) affected = true;
        }
      }
      return { value: currentValue + spent, affected };
    } else if (bindingName.startsWith('group-leftover-')) {
      const groupId = bindingName.slice(15);
      const groupCategories = categories.filter(c => c.group === groupId);
      let spent = 0;
      let affected = false;
      for (const c of groupCategories) {
        const adj = monthAdjustments[c.id];
        if (adj) {
          spent += adj.spent;
          if (adj.affected) affected = true;
        }
      }
      return { value: currentValue + spent, affected };
    } else if (bindingName === 'total-spent') {
      const expenseCategories = categories.filter(c => !c.is_income);
      let spent = 0;
      let affected = false;
      for (const c of expenseCategories) {
        const adj = monthAdjustments[c.id];
        if (adj) {
          spent += adj.spent;
          if (adj.affected) affected = true;
        }
      }
      return { value: currentValue + spent, affected };
    } else if (bindingName === 'total-leftover') {
      let spent = 0;
      let affected = false;
      for (const c of categories) {
        const adj = monthAdjustments[c.id];
        if (adj) {
          spent += adj.spent;
          if (adj.affected) affected = true;
        }
      }
      return { value: currentValue + spent, affected };
    } else if (bindingName === 'total-income') {
      const incomeCategories = categories.filter(c => c.is_income);
      let spent = 0;
      let affected = false;
      for (const c of incomeCategories) {
        const adj = monthAdjustments[c.id];
        if (adj) {
          spent += adj.spent;
          if (adj.affected) affected = true;
        }
      }
      return { value: currentValue + spent, affected };
    }

    return defaultValue;
  };

  return (
    <ScheduledTransactionsContext.Provider
      value={{ showScheduled, setShowScheduled, adjustValue }}
    >
      {children}
    </ScheduledTransactionsContext.Provider>
  );
}

export function useScheduledTransactions() {
  return useContext(ScheduledTransactionsContext);
}
