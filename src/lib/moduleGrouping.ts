import type {
  FunctionModule,
  IncrementalModuleAssignmentResult,
  RawFunctionModule,
  SubFunction,
  SubFunctionAnalysisResult,
} from './ai';

export interface ProjectFunctionInfo {
  name: string;
  file: string;
  description: string;
}

export const MODULE_COLORS = [
  '#2563eb',
  '#16a34a',
  '#ea580c',
  '#9333ea',
  '#0891b2',
  '#dc2626',
  '#ca8a04',
  '#4f46e5',
  '#0f766e',
  '#be123c',
];

export function makeFunctionKey(name: string, file: string) {
  return `${name}@@${file}`;
}

export function localizeModuleName(name: string) {
  if (name === 'Uncategorized') return '未分类模块';
  if (name === 'Core Flow') return '核心流程';
  return name;
}

export function localizeModuleDescription(description: string) {
  if (description === 'Functions that were not explicitly assigned by the AI module analysis.') {
    return 'AI 模块分析未明确归类到具体模块的函数。';
  }
  if (description === 'Fallback grouping generated locally because the AI module analysis returned no usable groups.') {
    return 'AI 模块分析没有返回可用分组，系统按整体流程生成了兜底模块。';
  }
  return description;
}

function flattenChildren(subFunctions: SubFunction[], acc: ProjectFunctionInfo[]) {
  for (const sub of subFunctions) {
    acc.push({
      name: sub.name,
      file: sub.file || '未知',
      description: sub.description || '暂无说明',
    });
    if (sub.children?.length) {
      flattenChildren(sub.children, acc);
    }
  }
}

export function flattenProjectFunctions(callStack: SubFunctionAnalysisResult | null, entryFile: string) {
  if (!callStack) {
    return [] as ProjectFunctionInfo[];
  }

  const functions: ProjectFunctionInfo[] = [
    {
      name: callStack.entryFunctionName,
      file: entryFile || '未知',
      description: '项目入口函数',
    },
  ];

  flattenChildren(callStack.subFunctions, functions);

  const deduped = new Map<string, ProjectFunctionInfo>();
  for (const item of functions) {
    deduped.set(makeFunctionKey(item.name, item.file), item);
  }
  return [...deduped.values()];
}

export function normalizeFunctionModules(rawModules: RawFunctionModule[], functions: ProjectFunctionInfo[]): FunctionModule[] {
  const functionMap = new Map(functions.map((item) => [makeFunctionKey(item.name, item.file), item]));
  const assigned = new Set<string>();

  const normalized = rawModules
    .slice(0, 9)
    .map((module, index) => {
      const moduleFunctions: ProjectFunctionInfo[] = [];

      for (const item of module.functions) {
        const key = makeFunctionKey(item.name, item.file);
        if (assigned.has(key)) {
          continue;
        }
        const resolved = functionMap.get(key);
        if (!resolved) {
          continue;
        }
        assigned.add(key);
        moduleFunctions.push(resolved);
      }

      if (!moduleFunctions.length) {
        return null;
      }

      return {
        id: `module-${index + 1}`,
        name: localizeModuleName(module.name),
        description: localizeModuleDescription(module.description),
        color: MODULE_COLORS[index % MODULE_COLORS.length],
        functions: moduleFunctions,
      } satisfies FunctionModule;
    })
    .filter((item): item is FunctionModule => item !== null);

  const unassigned = functions.filter((item) => !assigned.has(makeFunctionKey(item.name, item.file)));

  if (unassigned.length > 0) {
    if (normalized.length < 10) {
      normalized.push({
        id: `module-${normalized.length + 1}`,
        name: '未分类模块',
        description: 'AI 模块分析未明确归类到具体模块的函数。',
        color: MODULE_COLORS[normalized.length % MODULE_COLORS.length],
        functions: unassigned,
      });
    } else if (normalized.length > 0) {
      normalized[normalized.length - 1] = {
        ...normalized[normalized.length - 1],
        functions: [...normalized[normalized.length - 1].functions, ...unassigned],
      };
    }
  }

  if (normalized.length === 0 && functions.length > 0) {
    normalized.push({
      id: 'module-1',
      name: '核心流程',
      description: 'AI 模块分析没有返回可用分组，系统按整体流程生成了兜底模块。',
      color: MODULE_COLORS[0],
      functions,
    });
  }

  return normalized;
}

export function buildFunctionModuleMap(modules: FunctionModule[]) {
  const map = new Map<string, FunctionModule>();
  for (const module of modules) {
    for (const fn of module.functions) {
      map.set(makeFunctionKey(fn.name, fn.file), module);
    }
  }
  return map;
}

export function mergeIncrementalModuleAssignments(
  existingModules: FunctionModule[],
  newFunctions: ProjectFunctionInfo[],
  assignments: IncrementalModuleAssignmentResult,
) {
  const nextModules = existingModules.map((module) => ({
    ...module,
    functions: [...module.functions],
  }));

  const moduleById = new Map(nextModules.map((module) => [module.id, module]));
  const moduleByName = new Map(nextModules.map((module) => [module.name, module]));
  const functionByKey = new Map(newFunctions.map((item) => [makeFunctionKey(item.name, item.file), item]));
  const assigned = new Set<string>();

  const appendFunction = (module: FunctionModule, fn: ProjectFunctionInfo) => {
    const key = makeFunctionKey(fn.name, fn.file);
    if (assigned.has(key)) {
      return;
    }

    if (module.functions.some((item) => makeFunctionKey(item.name, item.file) === key)) {
      assigned.add(key);
      return;
    }

    module.functions.push(fn);
    assigned.add(key);
  };

  for (const item of assignments.existingAssignments) {
    const key = makeFunctionKey(item.name, item.file);
    const fn = functionByKey.get(key);
    const module = moduleById.get(item.moduleId);
    if (!fn || !module) {
      continue;
    }

    appendFunction(module, fn);
  }

  for (const rawModule of assignments.newModules) {
    if (!rawModule.name.trim()) {
      continue;
    }

    let module = moduleByName.get(rawModule.name);
    if (!module) {
      module = {
        id: `module-${nextModules.length + 1}`,
        name: localizeModuleName(rawModule.name),
        description: localizeModuleDescription(rawModule.description),
        color: MODULE_COLORS[nextModules.length % MODULE_COLORS.length],
        functions: [],
      };
      nextModules.push(module);
      moduleById.set(module.id, module);
      moduleByName.set(module.name, module);
      moduleByName.set(rawModule.name, module);
    }

    for (const item of rawModule.functions) {
      const key = makeFunctionKey(item.name, item.file);
      const fn = functionByKey.get(key);
      if (!fn) {
        continue;
      }

      appendFunction(module, fn);
    }
  }

  const unassigned = newFunctions.filter((item) => !assigned.has(makeFunctionKey(item.name, item.file)));
  if (unassigned.length) {
    let uncategorized = nextModules.find((module) => module.name === '未分类模块');
    if (!uncategorized) {
      uncategorized = {
        id: `module-${nextModules.length + 1}`,
        name: '未分类模块',
        description: '新增函数暂未能稳定归入现有模块，已暂存到未分类模块。',
        color: MODULE_COLORS[nextModules.length % MODULE_COLORS.length],
        functions: [],
      };
      nextModules.push(uncategorized);
      moduleById.set(uncategorized.id, uncategorized);
      moduleByName.set(uncategorized.name, uncategorized);
    }

    for (const fn of unassigned) {
      appendFunction(uncategorized, fn);
    }
  }

  return nextModules;
}
