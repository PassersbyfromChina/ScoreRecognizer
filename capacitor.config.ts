import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.passersby.scorerecognizer",
  appName: "ScoreRecognizer",
  webDir: "dist",
  backgroundColor: "#f4f5f8",
  android: {
    allowMixedContent: false,
  },
  server: {
    androidScheme: "https",
  },
};

export default config;
