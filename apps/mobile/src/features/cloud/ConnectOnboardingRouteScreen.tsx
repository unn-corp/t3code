import { useAuth } from "@clerk/expo";
import { useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { reportAtomCommandResult, settlePromise } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { CloudEnvironmentRows } from "../connection/CloudEnvironmentRows";
import { splitEnvironmentSections } from "../connection/environmentSections";
import { optOutOfConnectOnboarding } from "./connectOnboardingOptOut";
import { hasCloudPublicConfig } from "./publicConfig";

/**
 * Post-sign-in onboarding sheet for T3 Connect. Mobile never publishes
 * environments itself — it consumes ones published elsewhere — so this simply
 * surfaces the account's T3 Connect environments right after sign-in so every
 * device can be connected in one go. It shows on every sign-in: sign-out
 * clears the connected environments, so each new session starts from zero.
 */
export function ConnectOnboardingRouteScreen() {
  return hasCloudPublicConfig() ? <ConfiguredConnectOnboardingRouteScreen /> : null;
}

function ConfiguredConnectOnboardingRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const { connectedEnvironments, onReconnectEnvironment } = useRemoteConnections();
  const { connectedCloudEnvironments } = splitEnvironmentSections({
    connectedEnvironments,
    cloudEnvironments: null,
  });

  const handleDone = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const handleDontShowAgain = useCallback(() => {
    if (userId) {
      void (async () => {
        const result = await settlePromise(() => optOutOfConnectOnboarding(userId));
        reportAtomCommandResult(result, { label: "connect onboarding opt-out" });
      })();
    }
    navigation.goBack();
  }, [navigation, userId]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{
          gap: 24,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 20,
          paddingTop: 24,
        }}
      >
        <View className="gap-1.5">
          <View className="flex-row items-start justify-between gap-3">
            <Text className="flex-1 text-2xl font-t3-bold text-foreground">Set up T3 Connect</Text>
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={handleDone}
              className="rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
            >
              <Text className="text-xs font-t3-bold uppercase text-foreground-muted">Skip</Text>
            </Pressable>
          </View>
          <Text className="text-sm leading-normal text-foreground-muted">
            Environments published from your other devices are ready to connect here.
          </Text>
        </View>

        {isSignedIn ? (
          <CloudEnvironmentRows
            connectedCloudEnvironments={connectedCloudEnvironments}
            onReconnectEnvironment={onReconnectEnvironment}
          />
        ) : (
          <View collapsable={false} className="rounded-[24px] bg-card p-5">
            <Text className="text-sm leading-normal text-foreground-muted">
              Sign in to your T3 account to set up T3 Connect.
            </Text>
          </View>
        )}

        <View className="gap-3">
          <Pressable
            accessibilityRole="button"
            onPress={handleDone}
            className="min-h-[48px] items-center justify-center rounded-[18px] bg-card active:opacity-70"
          >
            <Text className="text-base font-t3-bold text-foreground">Done</Text>
          </Pressable>
          {userId ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={handleDontShowAgain}
              className="items-center py-1 active:opacity-70"
            >
              <Text className="text-xs text-foreground-muted">{"Don't show this again"}</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
