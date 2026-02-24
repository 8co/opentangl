export interface VerifyCommand {
  command: string;
  args: string[];
  optional?: boolean;
}

export interface ProjectProfile {
  language: 'TypeScript' | 'JavaScript';
  codeLang: 'typescript' | 'javascript';
  fileExt: 'ts' | 'js';
  moduleSystem: string;
  languageInstructions: string;
  defaultVerify: VerifyCommand[];
  defaultScanDirs: string[];
  defaultSkipPatterns: string[];
  conventions: string;
  routerFile?: string;
}

export const PROJECT_PROFILES: Record<string, ProjectProfile> = {
  'typescript-node': {
    language: 'TypeScript',
    codeLang: 'typescript',
    fileExt: 'ts',
    moduleSystem: 'ES modules (import/export, .js extensions in imports)',
    languageInstructions: 'TypeScript strict mode — no `any`, no implicit types.',
    defaultVerify: [
      {
        command: 'npx',
        args: ['tsc', '--noEmit'],
      },
    ],
    defaultScanDirs: ['src'],
    defaultSkipPatterns: ['node_modules', 'dist', '.git'],
    conventions: '',
  },
  'serverless-js': {
    language: 'JavaScript',
    codeLang: 'javascript',
    fileExt: 'js',
    moduleSystem: 'CommonJS (require/module.exports)',
    languageInstructions: 'Plain JavaScript (ES2022+). No TypeScript syntax. Use JSDoc for type hints where helpful.',
    defaultVerify: [
      {
        command: 'npx',
        args: ['webpack', '--mode', 'production'],
      },
    ],
    defaultScanDirs: ['src', 'handlers'],
    defaultSkipPatterns: ['node_modules', '.serverless', '.webpack'],
    conventions: 'Handler pattern: module.exports = { handler: async function }. AWS Lambda + DynamoDB + SQS.',
  },
  'react-vite': {
    language: 'TypeScript',
    codeLang: 'typescript',
    fileExt: 'ts',
    moduleSystem: 'ES modules (import/export, .js extensions in imports)',
    languageInstructions: 'TypeScript strict mode — no `any`, no implicit types.',
    defaultVerify: [
      {
        command: 'npm',
        args: ['run', 'build'],
      },
    ],
    defaultScanDirs: ['src'],
    defaultSkipPatterns: ['node_modules', 'dist'],
    routerFile: 'src/App.tsx',
    conventions: [
      'Act as a senior principal engineer at a top-tier company (Stripe, Figma, Linear). Every UI change must meet that bar.',
      '',
      '=== CRITICAL: DESIGN SYSTEM RULES (NEVER VIOLATE) ===',
      '',
      'This project uses shadcn/ui with Tailwind CSS. The design system is defined in `src/index.css` via CSS custom properties inside `@layer base`. These variables power EVERY component in the app.',
      '',
      'NEVER modify these foundational files:',
      '- `src/index.css` — Contains all CSS custom properties (--background, --foreground, --primary, --card, --muted, --accent, --destructive, --border, --input, --ring, --sidebar-*, and their .dark variants). Changing, removing, or rewriting these variables will break the entire UI.',
      '- `src/components/ui/*` — These are shadcn/ui primitives. NEVER rewrite, simplify, or replace them. They have specific Tailwind classes that reference the CSS variables above. If you strip those classes, you break the design system.',
      '- `src/components/Layout.tsx` — The app shell. Do not restructure.',
      '',
      'If a task asks you to implement something related to theming, dark mode, or global styles, the answer is: the system already supports it via the `.dark` class and `@layer base` variables in `index.css`. Do NOT create an alternative system. Do NOT replace `@tailwind` directives with `@import`. Do NOT create new CSS variable schemes. The existing system works.',
      '',
      '=== DESIGN QUALITY ===',
      '',
      '- Figma-level precision: consistent spacing (multiples of 4px via Tailwind), pixel-perfect alignment, clear visual hierarchy.',
      '- Every screen must look polished enough to ship at Stripe or Linear. No rough edges, no placeholder styling.',
      '- Use gradients, shadows, color accents, and subtle depth. Pages should feel rich and crafted — not flat wireframes.',
      '- Responsive by default: mobile-first, then sm/md/lg/xl breakpoints.',
      '- Use the existing color palette: gradient headers (blue-600 via purple-600 to pink-600), colored accent cards, subtle background gradients (blue-50/purple-50/pink-50).',
      '',
      '=== COMPLETENESS ===',
      '',
      '- NEVER output placeholder content like `{/* Add more items here */}` or `{/* TODO */}`. Every component must be fully implemented with real content, real options, and real functionality.',
      '- NEVER create stub functions or empty handlers. If you add a button, wire it to real logic.',
      '- NEVER simplify an existing component by removing features, options, or styling. If you touch a file, the output must be AT LEAST as complete as the input.',
      '- If a file you output is shorter than the original, you almost certainly broke something. Include ALL original functionality.',
      '',
      '=== COMPONENT STACK ===',
      '',
      '- UI primitives: shadcn/ui (built on Radix UI). ALWAYS check `src/components/ui/` for an existing component before creating a new one.',
      '- Styling: Tailwind CSS only. Use the project theme tokens: `primary`, `secondary`, `muted`, `accent`, `destructive`, `card`, `popover`, `border`, `input`, `ring`.',
      '- Use `cn()` from `src/lib/utils.ts` for conditional/merged class names (clsx + tailwind-merge).',
      '- Icons: Lucide React (`lucide-react`). Do not use other icon libraries.',
      '- Animations: Framer Motion for page transitions and micro-interactions. Keep animations subtle and purposeful.',
      '',
      '=== PATTERNS ===',
      '',
      '- Functional components only. No class components.',
      '- Extract reusable logic into custom hooks in `src/hooks/`.',
      '- State management: Zustand for client state.',
      '- Data fetching: `@tanstack/react-query` v5. ALWAYS import from `@tanstack/react-query` (NEVER `react-query`). useQuery/useMutation require the object form: `useQuery({ queryKey: [...], queryFn })`. NEVER use positional arguments — v4 syntax compiles but crashes at runtime.',
      '- Forms: React Hook Form + Zod schemas for validation.',
      '- Routing: React Router v6 (`<Routes>`/`<Route>`, `useNavigate`). When creating a new page in `src/pages/`, you MUST also add the corresponding `<Route>` in the router file (typically `src/App.tsx`).',
      '- Auth context is in `src/context/AuthContext.tsx` — use the existing auth hooks.',
      '',
      '=== PAGE LAYOUT (NEVER VIOLATE) ===',
      '',
      '- BEFORE modifying any page, READ the existing layout structure (grid columns, sidebar, tabs). Understand which column/section each component belongs in.',
      '- Preserve existing grid/layout structure. If a page uses a two-column grid with a narrow sidebar, do NOT move main content into the sidebar or vice versa.',
      '- Sidebars (narrow fixed-width columns, typically 280-360px) are for COMPACT metadata only: IDs, dates, tags, small stat counters. NEVER put content-heavy panels, forms, or data tables in a sidebar.',
      '- When adding new components to an existing page, place them where they contextually belong: comment-related panels go in/near the Comments tab, revision stats go in/near the Revisions tab, etc.',
      '- If a page has tabs, prefer adding related content INSIDE the relevant tab rather than stacking more panels outside the tab structure.',
      '- Count the panels in each layout region before and after your changes. If one column grows by more than 2 panels, you are probably putting content in the wrong place.',
      '',
      '=== CODE QUALITY ===',
      '',
      '- No inline styles. No `style={{}}` props. Tailwind classes only.',
      '- No hardcoded color values — use theme tokens (`bg-primary`, `text-muted-foreground`, etc.) or explicit Tailwind colors (e.g. `text-blue-700`, `bg-purple-50`) for accent colors.',
      '- Components must be reusable. Extract shared patterns into `src/components/` with clear props interfaces.',
      '- Files use `.tsx` for components, `.ts` for utilities/hooks/services.',
      '- Accessibility: Radix UI handles ARIA attributes. Ensure custom elements have proper roles and labels.',
    ].join('\n'),
  },
  'serverless-ts': {
    language: 'TypeScript',
    codeLang: 'typescript',
    fileExt: 'ts',
    moduleSystem: 'ES modules (import/export)',
    languageInstructions: 'TypeScript strict mode — no `any`, no implicit types.',
    defaultVerify: [
      {
        command: 'npx',
        args: ['webpack', '--mode', 'production'],
      },
    ],
    defaultScanDirs: ['src', 'resources', 'prompts'],
    defaultSkipPatterns: ['node_modules', '.serverless', '.webpack'],
    conventions: 'Handler pattern: export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult>. AWS Lambda + DynamoDB. Use @aws-sdk v3 modular imports. Prompt templates in prompts/ directory loaded via readFileSync and bundled by webpack.',
  },
  'nextjs-ts': {
    language: 'TypeScript',
    codeLang: 'typescript',
    fileExt: 'ts',
    moduleSystem: 'ES modules (import/export, .js extensions in imports)',
    languageInstructions: 'TypeScript strict mode — no `any`, no implicit types.',
    defaultVerify: [
      {
        command: 'npm',
        args: ['run', 'build'],
      },
    ],
    defaultScanDirs: ['src', 'app', 'pages'],
    defaultSkipPatterns: ['node_modules', '.next'],
    conventions: '',
  },
  'sst-v2': {
    language: 'TypeScript',
    codeLang: 'typescript',
    fileExt: 'ts',
    moduleSystem: 'ES modules (import/export, .js extensions in imports)',
    languageInstructions: 'TypeScript strict mode — no `any`, no implicit types.',
    defaultVerify: [
      {
        command: 'npx',
        args: ['tsc', '--noEmit'],
      },
    ],
    defaultScanDirs: ['src', 'infra', 'packages'],
    defaultSkipPatterns: ['node_modules', '.sst'],
    conventions: '',
  },
  'expo-react-native': {
    language: 'TypeScript',
    codeLang: 'typescript',
    fileExt: 'ts',
    moduleSystem: 'ES modules (import/export, .js extensions in imports)',
    languageInstructions: 'TypeScript strict mode — no `any`, no implicit types.',
    defaultVerify: [
      {
        command: 'npx',
        args: ['expo-doctor'],
      },
    ],
    defaultScanDirs: ['src', 'app'],
    defaultSkipPatterns: ['node_modules', '.expo'],
    conventions: '',
  },
};

export function getProfile(projectType: string): ProjectProfile | undefined {
  return PROJECT_PROFILES[projectType];
}

export function getLanguageVarsFromProfile(profile: ProjectProfile): Record<string, string> {
  return {
    language: profile.language,
    code_lang: profile.codeLang,
    file_ext: profile.fileExt,
    module_system: profile.moduleSystem,
    language_instructions: profile.languageInstructions,
    conventions: profile.conventions,
  };
}
