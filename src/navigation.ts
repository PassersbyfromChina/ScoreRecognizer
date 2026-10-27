export type Screen =
  | "home"
  | "students"
  | "template"
  | "capture"
  | "review"
  | "export"
  | "settings";

export interface NavProps {
  onNavigate: (screen: Screen) => void;
}
