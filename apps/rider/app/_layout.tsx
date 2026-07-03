import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AuthProvider } from "@rida/mobile-shared";

const queryClient = new QueryClient();

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Stack screenOptions={{ headerShown: false }}>
            {/* Location select renders as a self-animated sheet over a still-visible
                Home — transparentModal keeps push/back + params semantics identical
                to a normal route; the screen owns its slide-up/backdrop motion. */}
            <Stack.Screen
              name="ride/location"
              options={{ presentation: "transparentModal", animation: "none" }}
            />
          </Stack>
        </AuthProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
