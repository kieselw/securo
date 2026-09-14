import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { budgets } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { currentMonth, shiftMonth, monthLabel } from '@/lib/month-utils'
import { CategoryIcon } from '@/components/category-icon'
import { Skeleton } from '@/components/ui/skeleton'
import type { BudgetVsActual } from '@/types'

interface BudgetByGroupProps {
  currency: string
  locale: string
}

interface GroupRollup {
  groupId: string
  groupName: string
  budgetSum: number
  hasBudget: boolean
  actualSum: number
  pctUsed: number | null
  categories: BudgetVsActual[]
}

function barColorFor(pct: number | null) {
  if (pct === null) return 'bg-muted-foreground/20'
  if (pct > 100) return 'bg-rose-500'
  if (pct >= 80) return 'bg-amber-400'
  return 'bg-emerald-500'
}

function textColorFor(pct: number | null) {
  if (pct === null) return 'text-muted-foreground'
  if (pct > 100) return 'text-rose-500'
  if (pct >= 80) return 'text-amber-500'
  return 'text-muted-foreground'
}

export function BudgetByGroup({ currency, locale }: BudgetByGroupProps) {
  const { t } = useTranslation()
  const { mask } = usePrivacyMode()
  const [month, setMonth] = useState(() => currentMonth())

  const { data, isLoading } = useQuery({
    queryKey: ['budgets', 'comparison', month],
    queryFn: () => budgets.comparison(`${month}-01`),
  })

  const groups = useMemo<GroupRollup[]>(() => {
    if (!data) return []
    const byGroup = new Map<string, BudgetVsActual[]>()
    for (const row of data) {
      const key = row.group_id ?? '__none__'
      const list = byGroup.get(key)
      if (list) list.push(row)
      else byGroup.set(key, [row])
    }

    const rollups: GroupRollup[] = Array.from(byGroup.entries()).map(([groupId, rows]) => {
      const budgeted = rows.filter((r) => r.budget_amount != null)
      const budgetSum = budgeted.reduce((s, r) => s + (r.budget_amount ?? 0), 0)
      const actualSum = rows.reduce((s, r) => s + r.actual_amount, 0)
      const hasBudget = budgeted.length > 0
      const pctUsed = hasBudget && budgetSum > 0 ? (actualSum / budgetSum) * 100 : null
      const sortedRows = [...rows].sort((a, b) => (b.percentage_used ?? -1) - (a.percentage_used ?? -1))
      return {
        groupId,
        groupName: rows[0].group_name ?? t('groups.noGroup'),
        budgetSum,
        hasBudget,
        actualSum,
        pctUsed,
        categories: sortedRows,
      }
    })

    return rollups.sort((a, b) => (b.pctUsed ?? -1) - (a.pctUsed ?? -1))
  }, [data, t])

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full rounded-xl" />
        ))}
      </div>
    )
  }

  return (
    <div>
      {/* Month stepper */}
      <div className="flex items-center gap-1 mb-5">
        <button
          className="h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:border-border hover:text-foreground transition-all text-base"
          onClick={() => setMonth(shiftMonth(month, -1))}
        >&#8249;</button>
        <span className="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium text-foreground min-w-[160px]">
          {monthLabel(month, locale).replace(/^\w/, (c) => c.toUpperCase())}
        </span>
        <button
          className="h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:border-border hover:text-foreground transition-all text-base"
          onClick={() => setMonth(shiftMonth(month, 1))}
        >&#8250;</button>
      </div>

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm text-center py-16">{t('reports.noData')}</p>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => {
            const remaining = group.budgetSum - group.actualSum
            return (
              <div key={group.groupId} className="bg-card rounded-xl border border-border shadow-sm">
                <div className="px-5 py-4 border-b border-border">
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <span className="text-sm font-semibold text-foreground">{group.groupName}</span>
                    <span className="text-sm font-bold tabular-nums text-foreground shrink-0">
                      {mask(formatCurrency(group.actualSum, currency, locale))}
                      {group.hasBudget && (
                        <span className="text-muted-foreground font-medium">
                          {' '}{t('dashboard.ofBudget', { budget: formatCurrency(group.budgetSum, currency, locale) })}
                        </span>
                      )}
                    </span>
                  </div>
                  {group.hasBudget ? (
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-2 bg-muted/60 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${barColorFor(group.pctUsed)}`}
                          style={{ width: `${Math.min(group.pctUsed ?? 0, 100)}%` }}
                        />
                      </div>
                      <span className={`text-xs font-bold tabular-nums shrink-0 ${textColorFor(group.pctUsed)}`}>
                        {remaining >= 0
                          ? t('reports.remaining', { amount: mask(formatCurrency(remaining, currency, locale)) })
                          : t('reports.overBudget', { amount: mask(formatCurrency(-remaining, currency, locale)) })}
                      </span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('reports.noBudgetSet')}</p>
                  )}
                </div>

                <div className="p-2">
                  {group.categories.map((cat) => {
                    const hasBudget = cat.budget_amount != null
                    const catRemaining = hasBudget ? cat.budget_amount! - cat.actual_amount : null
                    return (
                      <div key={cat.category_id} className="rounded-lg px-3 py-2.5 hover:bg-muted/50 transition-colors">
                        <div className="flex items-center gap-3">
                          <CategoryIcon icon={cat.category_icon} color={cat.category_color} size="md" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2 mb-1">
                              <span className="text-sm font-medium text-foreground truncate">{cat.category_name}</span>
                              <span className="text-sm font-semibold tabular-nums text-foreground shrink-0">
                                {mask(formatCurrency(cat.actual_amount, currency, locale))}
                              </span>
                            </div>
                            {hasBudget ? (
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-1.5 bg-muted/60 rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full transition-all ${barColorFor(cat.percentage_used)}`}
                                    style={{ width: `${Math.min(cat.percentage_used ?? 0, 100)}%` }}
                                  />
                                </div>
                                <span className={`text-[11px] tabular-nums font-medium shrink-0 ${textColorFor(cat.percentage_used)}`}>
                                  {catRemaining! >= 0
                                    ? t('reports.remaining', { amount: mask(formatCurrency(catRemaining!, currency, locale)) })
                                    : t('reports.overBudget', { amount: mask(formatCurrency(-catRemaining!, currency, locale)) })}
                                </span>
                              </div>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">{t('reports.noBudgetSet')}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
