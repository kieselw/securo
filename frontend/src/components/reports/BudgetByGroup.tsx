import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  budgets,
  transactions,
  categories as categoriesApi,
  categoryGroups as categoryGroupsApi,
  accounts as accountsApi,
} from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { currentMonth, monthLabel, monthRange, monthLastDay } from '@/lib/month-utils'
import { getAccountName } from '@/lib/account-utils'
import { CategoryIcon } from '@/components/category-icon'
import { MonthStepper } from '@/components/month-stepper'
import { Skeleton } from '@/components/ui/skeleton'
import { TransactionDrillDown, type DrillDownFilter } from '@/components/transaction-drill-down'
import { TransactionDialog, type TransactionSavePayload } from '@/components/transaction-dialog'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { extractApiError } from '@/lib/api-errors'
import type { BudgetVsActual, Transaction } from '@/types'

interface BudgetByGroupProps {
  currency: string
  locale: string
}

interface GroupRollup {
  groupId: string
  groupName: string
  budgetSum: number
  hasBudget: boolean
  // Total spend across every category in the group, budgeted or not — the
  // headline "how much has this group spent" figure.
  actualSum: number
  // Spend from budgeted categories only — what `remaining`/`pctUsed` are
  // computed against, so an unbudgeted category's spend can't invent or
  // inflate an "over budget" state the budgeted categories don't have.
  budgetedActualSum: number
  pctUsed: number | null
  categories: RowPace[]
}

interface RowPace extends BudgetVsActual {
  hasBudget: boolean
  budgetNum: number
  actualNum: number
  projectedNum: number
  // Known recurring/scheduled amount not posted yet this month (the gap
  // between what's already spent and what the server projects by month-end).
  upcoming: number
  // budget - projected: what's left once already-known future recurring
  // transactions are accounted for, not just what's posted so far.
  flexible: number | null
  safeThisWeek: number | null
  pct: number | null
  status: 'ok' | 'warn' | 'bad'
  // Already over budget from actual spend alone (not counting anything still
  // to post) — when true, every section shows the SAME amount for "over by",
  // computed the same way as the plain category rows below. Only when spend
  // so far is still under budget but scheduled recurring transactions would
  // push it over do we switch to forecast language ("previsão estoura em").
  alreadyOver: boolean
  overActual: number
}

// `budget_amount`/`actual_amount` come back as JSON strings (serialized
// Decimal) despite the TS type claiming `number` — coerce everywhere before
// doing arithmetic, or `0 + "12.50"` silently string-concatenates instead of
// adding and later collapses to NaN.
const num = (v: number | string | null | undefined): number => (v == null ? 0 : Number(v))

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
  const queryClient = useQueryClient()
  const [month, setMonth] = useState(() => currentMonth())
  const [drillDown, setDrillDown] = useState<DrillDownFilter | null>(null)
  const [editingTx, setEditingTx] = useState<Transaction | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['budgets', 'comparison', month],
    queryFn: () => budgets.comparison(`${month}-01`),
  })

  const { from: monthFrom, to: monthTo } = monthRange(month)

  const { data: categoriesList } = useQuery({ queryKey: ['categories'], queryFn: categoriesApi.list })
  const { data: categoryGroupsList } = useQuery({ queryKey: ['categoryGroups'], queryFn: categoryGroupsApi.list })
  const { data: accountsList } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() })

  const updateMutation = useMutation({
    mutationFn: ({ id, ...payload }: TransactionSavePayload & { id: string }) => transactions.update(id, payload),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setDialogOpen(false)
      setEditingTx(null)
    },
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => transactions.delete(id),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setDialogOpen(false)
      setEditingTx(null)
    },
  })
  const unlinkTransferMutation = useMutation({
    mutationFn: (pairId: string) => transactions.unlinkTransfer(pairId),
    onSuccess: () => invalidateFinancialQueries(queryClient),
  })

  // How far into (or outside) the selected month "today" falls — drives both
  // the per-category weekly pace below and the headline's "N days left" line.
  const monthMeta = useMemo(() => {
    const daysInMonth = monthLastDay(month)
    const today = currentMonth()
    const isCurrentMonth = month === today
    const isFutureMonth = month > today
    const daysRemaining = isCurrentMonth
      ? Math.max(1, daysInMonth - new Date().getDate() + 1)
      : isFutureMonth
        ? daysInMonth
        : 1
    const weeksRemaining = Math.max(1, Math.ceil(daysRemaining / 7))
    return { isCurrentMonth, daysRemaining, weeksRemaining }
  }, [month])

  // Single source of truth for every number on this page: budget minus
  // what's already spent (posted transactions + pending ones folded in, via
  // the server's `pending_amount` — same currency-conversion and split-share
  // adjustments as `actual_amount`, capped at today so a future-dated pending
  // row never counts as already spent) minus what's already known to be
  // coming (recurring transactions the server projected but hasn't posted
  // yet), divided by the weeks left to close the month. Both the
  // group/category list and the "Livre essa semana" headline read off this
  // same array, so "how much over budget is this category" never has two
  // different answers depending on which section you're looking at.
  const rows = useMemo<RowPace[]>(() => {
    if (!data) return []
    const { weeksRemaining } = monthMeta

    return data.map((r) => {
      const hasBudget = r.budget_amount != null
      const budgetNum = num(r.budget_amount)
      const postedActual = num(r.actual_amount)
      const pending = num(r.pending_amount)
      const actualNum = postedActual + pending
      const projectedNum = num(r.projected_amount)
      // What's projected already includes pending (server-side), so folding
      // pending into `actual` here means `upcoming` naturally shrinks to just
      // the genuinely-not-yet-existing recurring/forecast portion instead of
      // double-counting the pending charge as both "spent" and "still coming".
      const upcoming = Math.max(0, projectedNum - actualNum)
      const flexible = hasBudget ? budgetNum - projectedNum : null
      const safeThisWeek = hasBudget ? Math.max(0, flexible!) / weeksRemaining : null
      const pct = hasBudget && budgetNum > 0 ? (projectedNum / budgetNum) * 100 : null
      const alreadyOver = hasBudget && actualNum > budgetNum
      const overActual = alreadyOver ? actualNum - budgetNum : 0
      // A category budgeted at exactly 0 has no percentage to compute (`pct`
      // stays null above), but it can still be over budget the moment it has
      // any spend — don't let it default to 'ok' forever just because there's
      // no ratio to threshold against.
      let status: RowPace['status'] = 'ok'
      if (pct !== null) {
        if (pct > 100) status = 'bad'
        else if (pct >= 80) status = 'warn'
      } else if (hasBudget && budgetNum === 0 && (actualNum > 0 || projectedNum > 0)) {
        status = 'bad'
      }
      return {
        ...r, hasBudget, budgetNum, actualNum, projectedNum, upcoming, flexible,
        safeThisWeek, pct, status, alreadyOver, overActual,
      }
    })
  }, [data, monthMeta])

  const groups = useMemo<GroupRollup[]>(() => {
    if (rows.length === 0) return []
    const byGroup = new Map<string, RowPace[]>()
    for (const row of rows) {
      const key = row.group_id ?? '__none__'
      const list = byGroup.get(key)
      if (list) list.push(row)
      else byGroup.set(key, [row])
    }

    const rollups: GroupRollup[] = Array.from(byGroup.entries()).map(([groupId, groupRows]) => {
      const budgeted = groupRows.filter((r) => r.hasBudget)
      const budgetSum = budgeted.reduce((s, r) => s + r.budgetNum, 0)
      const actualSum = groupRows.reduce((s, r) => s + r.actualNum, 0)
      // Only budgeted categories count toward the spent-vs-budget picture —
      // an unbudgeted category's spend was never meant to be tracked against
      // this budget, and folding it into `remaining`/`pctUsed` would invent
      // (or inflate) an "over budget" state the budgeted categories don't
      // actually have.
      const budgetedActualSum = budgeted.reduce((s, r) => s + r.actualNum, 0)
      const hasBudget = budgeted.length > 0
      const pctUsed = hasBudget && budgetSum > 0 ? (budgetedActualSum / budgetSum) * 100 : null
      const sortedRows = [...groupRows].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))
      return {
        groupId,
        groupName: groupRows[0].group_name ?? t('groups.noGroup'),
        budgetSum,
        hasBudget,
        actualSum,
        budgetedActualSum,
        pctUsed,
        categories: sortedRows,
      }
    })

    return rollups.sort((a, b) => (b.pctUsed ?? -1) - (a.pctUsed ?? -1))
  }, [rows, t])

  const weekly = useMemo(() => {
    if (rows.length === 0) return null
    const budgeted = rows.filter((r) => r.hasBudget)
    const headlineTotal = budgeted.reduce((s, r) => s + Math.max(0, r.safeThisWeek ?? 0), 0)
    const badCount = budgeted.filter((r) => r.status === 'bad').length
    const warnCount = budgeted.filter((r) => r.status === 'warn').length
    const totalBudget = budgeted.reduce((s, r) => s + r.budgetNum, 0)
    const totalProjected = budgeted.reduce((s, r) => s + r.projectedNum, 0)
    const usedPct = totalBudget > 0 ? Math.min(100, (totalProjected / totalBudget) * 100) : 0
    const attention = budgeted.filter((r) => r.status !== 'ok').sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))

    return { headlineTotal, badCount, warnCount, usedPct, attention }
  }, [rows])

  const openCategoryDrillDown = (cat: BudgetVsActual) => {
    setDrillDown({
      title: t('dashboard.drillDownCategory', { category: cat.category_name, month: monthLabel(month, locale) }),
      category_id: cat.category_id,
      type: 'debit',
      from: monthFrom,
      to: monthTo,
    })
  }

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
      <div className="mb-5">
        <MonthStepper
          value={month}
          onChange={setMonth}
          locale={locale}
          prevLabel={t('transactions.monthPrevious')}
          nextLabel={t('transactions.monthNext')}
        />
      </div>

      {/* Livre essa semana */}
      {weekly && (
        <div className="bg-card rounded-xl border border-border shadow-sm mb-5">
          <div className="px-5 py-4 border-b border-border">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">{t('reports.weeklyAvailable')}</p>
                <p className="text-3xl font-extrabold tabular-nums text-foreground tracking-tight">
                  {mask(formatCurrency(weekly.headlineTotal, currency, locale))}
                </p>
                {monthMeta.isCurrentMonth && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('reports.daysUntilClose', { days: monthMeta.daysRemaining, month: monthLabel(month, locale) })}
                  </p>
                )}
              </div>
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 ${
                weekly.badCount > 0 ? 'bg-rose-500/15 text-rose-500' : weekly.warnCount > 0 ? 'bg-amber-400/15 text-amber-500' : 'bg-emerald-500/15 text-emerald-500'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${weekly.badCount > 0 ? 'bg-rose-500' : weekly.warnCount > 0 ? 'bg-amber-400' : 'bg-emerald-500'}`} />
                {weekly.badCount > 0
                  ? t(weekly.badCount > 1 ? 'reports.categoriesOverBudgetMany' : 'reports.categoriesOverBudgetOne', { count: weekly.badCount })
                  : weekly.warnCount > 0
                    ? t('reports.attentionInCategories', { count: weekly.warnCount })
                    : t('reports.onTrack')}
              </span>
            </div>
            <div className="h-2 bg-muted/60 rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all ${barColorFor(weekly.usedPct)}`} style={{ width: `${weekly.usedPct}%` }} />
            </div>
          </div>

          <div className="p-4">
            <div className="flex items-center justify-between mb-3 px-1">
              <p className="text-xs font-semibold text-foreground">{t('reports.attentionHeading')}</p>
              <span className="text-[11px] text-muted-foreground">{weekly.attention.length}</span>
            </div>
            {weekly.attention.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-3">{t('reports.nothingOffPace')}</p>
            ) : (
              <div className="space-y-2">
                {weekly.attention.map((r) => (
                  <button
                    key={r.category_id}
                    type="button"
                    onClick={() => openCategoryDrillDown(r)}
                    className={`w-full flex items-center gap-3 rounded-lg border-l-[3px] bg-muted/20 px-3.5 py-2.5 text-left hover:bg-muted/40 transition-colors ${
                      r.status === 'bad' ? 'border-l-rose-500' : 'border-l-amber-400'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.category_color }} />
                    <span className="text-sm font-semibold text-foreground flex-1 min-w-0 truncate">{r.category_name}</span>
                    <span className="text-[11px] text-muted-foreground hidden sm:inline">
                      {r.alreadyOver
                        ? t('reports.alreadyOverBudget')
                        : r.upcoming > 0.5
                          ? t('reports.upcomingRecurring', { amount: formatCurrency(r.upcoming, currency, locale) })
                          : t('reports.closeToLimit')}
                    </span>
                    <span className={`text-sm font-bold tabular-nums shrink-0 ${r.status === 'bad' ? 'text-rose-500' : 'text-amber-500'}`}>
                      {r.alreadyOver
                        // Same basis as the plain category row below — "over
                        // by" always means the same thing everywhere on this
                        // page, so the two sections never show two different
                        // numbers for "how far over" the same category is.
                        ? t('reports.overBudget', { amount: mask(formatCurrency(r.overActual, currency, locale)) })
                        : r.flexible !== null && r.flexible < 0
                          ? t('reports.forecastOver', { amount: mask(formatCurrency(-r.flexible, currency, locale)) })
                          : t('reports.perWeek', { amount: mask(formatCurrency(r.safeThisWeek ?? 0, currency, locale)) })}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm text-center py-16">{t('reports.noData')}</p>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => {
            const remaining = group.budgetSum - group.budgetedActualSum
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
                    // Bar reads off actual spend (posted + pending, see `rows`
                    // above), not the projected-amount-based `cat.pct` used
                    // for the attention list's status — mixing the two made a
                    // row with little posted yet show a full red bar next to
                    // a large "remaining", contradictory.
                    const catPct = cat.hasBudget && cat.budgetNum > 0 ? (cat.actualNum / cat.budgetNum) * 100 : null
                    return (
                      <button
                        key={cat.category_id}
                        type="button"
                        onClick={() => openCategoryDrillDown(cat)}
                        className="w-full text-left rounded-lg px-3 py-2.5 hover:bg-muted/50 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-3">
                          <CategoryIcon icon={cat.category_icon} color={cat.category_color} size="md" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2 mb-1">
                              <span className="text-sm font-medium text-foreground truncate">{cat.category_name}</span>
                              <span className="text-sm font-semibold tabular-nums text-foreground shrink-0">
                                {mask(formatCurrency(cat.actualNum, currency, locale))}
                              </span>
                            </div>
                            {cat.hasBudget ? (
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-1.5 bg-muted/60 rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full transition-all ${barColorFor(catPct)}`}
                                    style={{ width: `${Math.min(catPct ?? 0, 100)}%` }}
                                  />
                                </div>
                                <span className={`text-[11px] tabular-nums font-medium shrink-0 ${textColorFor(catPct)}`}>
                                  {cat.alreadyOver
                                    // Same basis as the attention list above —
                                    // reuse `overActual` instead of
                                    // recomputing it here, so the two never
                                    // drift into showing different numbers.
                                    ? t('reports.overBudget', { amount: mask(formatCurrency(cat.overActual, currency, locale)) })
                                    : t('reports.remaining', { amount: mask(formatCurrency(cat.budgetNum - cat.actualNum, currency, locale)) })}
                                </span>
                              </div>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">{t('reports.noBudgetSet')}</span>
                            )}
                            {cat.upcoming > 0.5 && (
                              <p className="text-[10.5px] text-muted-foreground/80 mt-1">
                                {t('reports.upcomingRecurring', { amount: formatCurrency(cat.upcoming, currency, locale) })}
                              </p>
                            )}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <TransactionDrillDown
        filter={drillDown}
        onClose={() => setDrillDown(null)}
        onTransactionClick={(tx) => { setEditingTx(tx); setDialogOpen(true) }}
      />

      <TransactionDialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); setEditingTx(null) }}
        transaction={editingTx}
        categories={categoriesList ?? []}
        categoryGroups={categoryGroupsList ?? []}
        accounts={(accountsList ?? []).map((a: { id: string; name: string; display_name?: string | null }) => ({ id: a.id, name: getAccountName(a) }))}
        onSave={(payload) => {
          if (editingTx) updateMutation.mutate({ id: editingTx.id, ...payload })
        }}
        onDelete={() => {
          if (editingTx) deleteMutation.mutate(editingTx.id)
        }}
        onUnlinkTransfer={(pairId) => unlinkTransferMutation.mutate(pairId)}
        loading={updateMutation.isPending || deleteMutation.isPending || unlinkTransferMutation.isPending}
        error={updateMutation.error ? extractApiError(updateMutation.error) : deleteMutation.error ? extractApiError(deleteMutation.error) : null}
        isSynced={editingTx?.source === 'sync'}
      />
    </div>
  )
}
