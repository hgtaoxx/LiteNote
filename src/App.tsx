import { useEffect } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { WidgetShell } from "@/components/widget/WidgetShell";
import { ReminderWindow } from "@/components/window/ReminderWindow";
import { useAppInit } from "@/hooks/useAppInit";
import { startReminderPoll } from "@/lib/reminderPoll";
import { useSettingsStore } from "@/stores/settingsStore";

function App() {
  // 提醒弹窗窗口（?window=reminder）不挂载主应用，主题等不用关心
  const isReminderWindow =
    new URLSearchParams(window.location.search).get("window") === "reminder";

  if (isReminderWindow) {
    return (
      <ErrorBoundary>
        <ReminderWindow />
      </ErrorBoundary>
    );
  }

  return <MainApp />;
}

function MainApp() {
  useAppInit(true);

  const initialized = useSettingsStore((s) => s.initialized);
  const autoStart = useSettingsStore((s) => s.autoStart);
  const theme = useSettingsStore((s) => s.theme);

  // 绑定 data-theme 到 html 根节点
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!initialized) return;
    import("@tauri-apps/plugin-autostart")
      .then(({ enable, disable }) => (autoStart ? enable() : disable()))
      .catch((e) => console.error("[LiteNote] 应用自启设置失败:", e));
  }, [initialized, autoStart]);

  useEffect(() => {
    if (initialized) {
      startReminderPoll();
    }
  }, [initialized]);

  return (
    <ErrorBoundary>
      <WidgetShell />
    </ErrorBoundary>
  );
}

export default App;
