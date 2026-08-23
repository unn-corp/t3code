import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { agentDashboardEnvironment } from "../../state/agent-dashboard";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;

function Metric(props: {
  readonly label: string;
  readonly value: number;
  readonly tone?: "default" | "good" | "warning";
}) {
  return (
    <View className="min-w-[46%] flex-1 rounded-2xl border border-border bg-card p-4">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text
        className={
          props.tone === "good"
            ? "mt-1 text-2xl font-bold text-success"
            : props.tone === "warning"
              ? "mt-1 text-2xl font-bold text-warning"
              : "mt-1 text-2xl font-bold text-foreground"
        }
      >
        {props.value}
      </Text>
    </View>
  );
}

export function SettingsAgentDashboardRouteScreen() {
  const { environments } = useEnvironments();
  const environment = environments[0] ?? null;
  const query = useEnvironmentQuery(
    environment === null
      ? null
      : agentDashboardEnvironment.snapshot({
          environmentId: environment.environmentId,
          input: {},
        }),
  );
  const icon = useThemeColor("--color-icon");
  const health = query.data?.portfolioHealth;
  const findings = (query.data?.findings ?? [])
    .filter(
      (finding) =>
        finding.disposition.state !== "done" &&
        finding.disposition.state !== "dismissed" &&
        finding.disposition.state !== "blocked",
    )
    .toSorted(
      (left, right) =>
        SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
        Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt),
    )
    .slice(0, 8);
  const activeRuns =
    query.data?.automationRuns.filter(
      (run) => run.status === "queued" || run.status === "running" || run.status === "ingesting",
    ) ?? [];

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-5 px-5 py-5"
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={query.isPending} onRefresh={query.refresh} />}
        showsVerticalScrollIndicator={false}
      >
        <View className="flex-row items-center justify-between gap-3">
          <View className="min-w-0 flex-1">
            <Text className="text-xl font-bold text-foreground">Portfolio health</Text>
            <Text className="mt-1 text-sm text-foreground-muted" numberOfLines={1}>
              {environment?.label ?? "Connect an environment to load the dashboard"}
            </Text>
          </View>
          <Pressable
            accessibilityLabel="Refresh Agent Dashboard"
            accessibilityRole="button"
            className="rounded-full border border-border bg-card p-3"
            disabled={environment === null || query.isPending}
            onPress={query.refresh}
          >
            <SymbolView name="arrow.clockwise" size={18} tintColor={icon} type="monochrome" />
          </Pressable>
        </View>

        {query.error ? (
          <View className="rounded-2xl border border-destructive bg-card p-4">
            <Text className="font-semibold text-destructive">Dashboard unavailable</Text>
            <Text className="mt-1 text-sm text-foreground-muted">{query.error}</Text>
          </View>
        ) : null}

        {health ? (
          <View className="flex-row flex-wrap gap-3">
            <Metric label="Healthy" value={health.healthyRepositoryCount} tone="good" />
            <Metric
              label="Needs attention"
              value={health.attentionRepositoryCount}
              tone="warning"
            />
            <Metric label="Unassessed" value={health.unassessedRepositoryCount} />
            <Metric label="Open findings" value={health.openFindingCount} />
          </View>
        ) : null}

        <View className="gap-3">
          <View className="flex-row items-center justify-between">
            <Text className="text-lg font-bold text-foreground">Priority findings</Text>
            <Text className="text-sm text-foreground-muted">{findings.length}</Text>
          </View>
          {findings.length > 0 ? (
            findings.map((finding) => (
              <View className="rounded-2xl border border-border bg-card p-4" key={finding.id}>
                <View className="flex-row items-center justify-between gap-3">
                  <Text className="min-w-0 flex-1 font-semibold text-foreground" numberOfLines={2}>
                    {finding.title}
                  </Text>
                  <Text className="text-xs font-semibold uppercase text-foreground-muted">
                    {finding.severity}
                  </Text>
                </View>
                <Text className="mt-2 text-sm text-foreground-muted" numberOfLines={3}>
                  {finding.summary}
                </Text>
              </View>
            ))
          ) : (
            <View className="rounded-2xl border border-border bg-card p-5">
              <Text className="text-center text-foreground-muted">No open findings.</Text>
            </View>
          )}
        </View>

        <View className="rounded-2xl border border-border bg-card p-4">
          <Text className="font-semibold text-foreground">Active automation</Text>
          <Text className="mt-1 text-sm text-foreground-muted">
            {activeRuns.length === 0
              ? "No automation is running."
              : `${activeRuns.length} ${activeRuns.length === 1 ? "run is" : "runs are"} active.`}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
