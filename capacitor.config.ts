import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.applypilot.app",
  appName: "ApplyPilot",
  webDir: "web/dist",
  ios: {
    contentInset: "automatic",
  },
};

export default config;
