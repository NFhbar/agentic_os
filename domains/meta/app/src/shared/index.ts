// Barrel export for the shared design system.
// Apps import from here: `import { Icons, Card, StatusBadge } from '@/shared'`
// (or via the relative path until path aliases are set up).
//
// Locked by:
//   standard-app-architecture — manifest contract; apps consume shared/ from here
//   standard-app-design       — visual system the primitives implement
//   standard-app-persistence  — orthogonal (data) but shipped together as the OS app contract

// Components + design primitives
export {
  Icon,
  Icons,
  AgentChip,
  StatusBadge,
  ResultBadge,
  Sparkline,
  Switch,
  LangDot,
  CodeLine,
  CodePane,
  TrendChart,
  SeverityBar,
  Empty,
  SharedModal,
  Toast,
  Metric,
  sevClass,
  sevIcon,
  sevLabel,
  hl,
  useCollapsedFlag,
  SectionToggleRow,
} from './components';

export type {
  Severity,
  SkillAgent,
  Status,
  ResultKind,
  CodeLineData,
  CodeLineKind,
  TrendDatum,
} from './components';

// Layout — ActionBanner + future layout primitives
export { ActionBanner } from './layout';
export type { ActionBannerProps, ActionBannerTone, BannerAction } from './layout';

// Stepper — lifecycle stepper
export { Stepper } from './stepper';
export type { StepperStep, StepStatus } from './stepper';

// Stacked-bars — SeverityBar (re-exported above for back-compat) + CountStackedBar
export { CountStackedBar } from './stacked-bars';
export type { CountSegment } from './stacked-bars';

// Markdown rendering primitive
export { MarkdownBlock, splitOnUpdateSections } from './markdown';
export type { MarkdownDecorate, MarkdownSplitResult, UpdateSection } from './markdown';

// Dispatch modal
export { DispatchModal } from './dispatch-modal';
export type { DispatchModalProps, DispatchModalConfirm } from './dispatch-modal';

// Utilities
export { hex2rgba, cn, parsePRTitle, parseRepo } from './utils';

// Tooltip — portal-rendered hover tip; escapes overflow:hidden ancestors
export { Tooltip } from './Tooltip';
