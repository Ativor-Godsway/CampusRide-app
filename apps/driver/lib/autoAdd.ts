import { useState } from "react";
import { Alert } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { driverSettingsQueryKey, getDriverSettings, saveDriverSettings } from "@rida/mobile-shared";

/** "Auto-add riders on my way" (fill moving cars first): the switch in Account, off by default. */
export function useAutoAdd() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: driverSettingsQueryKey, queryFn: getDriverSettings, staleTime: 60_000 });
  const [saving, setSaving] = useState(false);
  const on = data?.autoAddRiders ?? false;
  const toggle = () => {
    if (saving) return;
    const next = !on;
    setSaving(true);
    queryClient.setQueryData(driverSettingsQueryKey, data ? { ...data, autoAddRiders: next } : undefined);
    saveDriverSettings(next)
      .then((saved) => queryClient.setQueryData(driverSettingsQueryKey, saved))
      .catch(() => {
        queryClient.setQueryData(driverSettingsQueryKey, data);
        Alert.alert("Couldn't save", "Check your connection and try again.");
      })
      .finally(() => setSaving(false));
  };
  return { on, saving, toggle };
}
