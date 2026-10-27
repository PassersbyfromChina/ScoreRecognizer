import type { ReactNode } from "react";
import { ArrowLeft, Camera, CheckSquare, FileDown, ScanLine } from "lucide-react";
import type { NavProps } from "../navigation";

function ComingSoon({
  icon,
  title,
  desc,
  bullets,
  onNavigate,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  bullets: string[];
  onNavigate: NavProps["onNavigate"];
}) {
  return (
    <div className="page-inner" style={{ maxWidth: 760 }}>
      <div className="card">
        <div className="card-body" style={{ padding: 34 }}>
          <div
            style={{
              width: 54,
              height: 54,
              borderRadius: 15,
              background: "var(--red-soft)",
              color: "var(--red)",
              display: "grid",
              placeItems: "center",
              marginBottom: 18,
            }}
          >
            {icon}
          </div>
          <h1 style={{ fontSize: 21, marginBottom: 8 }}>{title}</h1>
          <p className="muted" style={{ lineHeight: 1.8, marginBottom: 18 }}>
            {desc}
          </p>
          <div className="notice notice-info" style={{ marginBottom: 22 }}>
            <div>
              <b>正在开发中。</b>这一部分会和识别流程一起在接下来的版本里完成。
            </div>
          </div>
          <ul className="muted" style={{ lineHeight: 2, paddingLeft: 20, margin: "0 0 22px" }}>
            {bullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <button className="btn btn-secondary" onClick={() => onNavigate("home")}>
            <ArrowLeft size={16} />
            返回首页
          </button>
        </div>
      </div>
    </div>
  );
}

export function TemplateScreen({ onNavigate }: NavProps) {
  return (
    <ComingSoon
      icon={<ScanLine size={24} />}
      title="划分答题卡区域"
      desc="拍一张空白或已批改的答题卡作为样卡，应用会自动找出答题卡的边缘并矫正倾斜，然后交给 AI 标出每道题和姓名的位置，也可以手动拖动修改。"
      bullets={[
        "自动识别答题卡边缘，矫正倾斜与透视变形",
        "AI 初步划分题目与姓名区域（以试卷长边为 1 的坐标）",
        "拖动、缩放修改区域，支持一题多块",
        "保存为模板，同一套卷子直接复用",
      ]}
      onNavigate={onNavigate}
    />
  );
}

export function CaptureScreen({ onNavigate }: NavProps) {
  return (
    <ComingSoon
      icon={<Camera size={24} />}
      title="拍摄 / 上传答题卡"
      desc="批量拍摄或上传答题卡，图片会实时保存；拍完后自动矫正、识别，状态栏实时统计「待拍摄 / 待自动处理 / 待确认 / 已完成」。"
      bullets={[
        "电脑摄像头拍摄或批量选择图片",
        "手机在同一局域网扫码连接，只负责拍摄上传",
        "画面中央水平参考线，帮助把答题卡拍正",
        "图片实时落盘，断网也不丢",
      ]}
      onNavigate={onNavigate}
    />
  );
}

export function ReviewScreen({ onNavigate }: NavProps) {
  return (
    <ComingSoon
      icon={<CheckSquare size={24} />}
      title="核对识别结果"
      desc="三种核对视图：整张试卷、红笔局部放大、表格。红笔旁显示等大的识别数字，用键盘或触屏确认每一分。"
      bullets={[
        "Enter 通过、Tab 换题、Backspace 修改、Esc 取消",
        "识别不清 / 一题两个分数 / 一题无分数时强制人工确认",
        "修改实时保存，关掉再打开也不丢",
        "可随时切换到表格查看整班情况",
      ]}
      onNavigate={onNavigate}
    />
  );
}

export function ExportScreen({ onNavigate }: NavProps) {
  return (
    <ComingSoon
      icon={<FileDown size={24} />}
      title="导出成绩"
      desc="随时可以导出 Excel：第一列姓名、后面每列一道题、最后一列总分。没核对完也能导，未确认的格子会按设置标红。"
      bullets={[
        "姓名为行、题号为列，含总分列",
        "未确认的格子默认红色问号（设置里可改）",
        "导出后应用内保留备份",
        "支持导出历史记录随时重下",
      ]}
      onNavigate={onNavigate}
    />
  );
}
