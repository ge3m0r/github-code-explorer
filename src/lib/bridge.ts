import type { AiAnalysisResult, NodeAttribute, SubFunction, SubFunctionAnalysisResult } from './ai';
import { locateInFile } from './functionLocator';

export interface BridgeStrategyContext {
  owner: string;
  repo: string;
  aiResult: AiAnalysisResult;
  entryFilePath: string;
  entryFileContent: string;
  sourceFiles: string[];
  fetchContent: (filePath: string) => Promise<string>;
}

export interface BridgeStrategyMatch {
  result: SubFunctionAnalysisResult;
  details: {
    strategyId: string;
    label: string;
    framework: string;
    reason: string;
    rootCount: number;
    filesScanned: number;
  };
}

interface BridgeStrategy {
  id: string;
  label: string;
  framework: string;
  tryBuild: (context: BridgeStrategyContext) => Promise<BridgeStrategyMatch | null>;
}

interface ResolvedEntryFile {
  filePath: string;
  content: string;
}

interface SpringControllerClass {
  className: string;
  basePaths: string[];
}

interface PythonImportMap {
  symbolFiles: Map<string, string>;
  moduleFiles: Map<string, string>;
}

const DJANGO_HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];
const SPRING_METHOD_ANNOTATIONS = ['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping', 'RequestMapping'];
const SPRING_HTTP_ANNOTATION_TO_METHOD: Record<string, string[]> = {
  GetMapping: ['GET'],
  PostMapping: ['POST'],
  PutMapping: ['PUT'],
  DeleteMapping: ['DELETE'],
  PatchMapping: ['PATCH'],
};

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniq<T>(values: T[]) {
  return [...new Set(values)];
}

function normalizeTokens(values: string[]) {
  return values.map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function includesToken(values: string[], expected: string[]) {
  const tokens = normalizeTokens(values);
  return expected.some((value) => tokens.includes(value));
}

function countChar(input: string, target: string) {
  return [...input].filter((char) => char === target).length;
}

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
}

function dirname(filePath: string) {
  const parts = normalizePath(filePath).split('/');
  parts.pop();
  return parts.join('/');
}

function joinPath(...parts: string[]) {
  const stack: string[] = [];
  for (const part of parts.flatMap((item) => normalizePath(item).split('/')).filter(Boolean)) {
    if (part === '.') {
      continue;
    }
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

function fileName(filePath: string) {
  const parts = normalizePath(filePath).split('/');
  return parts[parts.length - 1] || '';
}

function extractQuotedStrings(input: string) {
  const result: string[] = [];
  const regex = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    result.push((match[1] || match[2] || '').replace(/\\(["'])/g, '$1'));
  }
  return result;
}

function normalizeRoutePath(path: string) {
  const trimmed = path.trim().replace(/^\^/, '').replace(/\$$/, '');
  if (!trimmed || trimmed === '/') {
    return '/';
  }
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const normalized = withSlash.replace(/\/{2,}/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

function combineRoutePath(prefix: string, path: string) {
  return normalizeRoutePath(`${prefix}/${path}`);
}

function formatRouteLabels(paths: string[], methods: string[]) {
  const normalizedPaths = paths.length ? paths.map((path) => normalizeRoutePath(path)) : ['/'];
  const normalizedMethods = methods.length ? methods : ['ANY'];
  const labels: string[] = [];
  for (const method of normalizedMethods) {
    for (const path of normalizedPaths) {
      labels.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return uniq(labels);
}

function buildRouteAttributes(routeLabels: string[], framework: string): NodeAttribute[] {
  const attributes: NodeAttribute[] = [{ label: framework, tone: 'success' }];
  if (!routeLabels.length) {
    attributes.push({ label: 'HTTP Route', tone: 'info' });
    return attributes;
  }
  attributes.push(...routeLabels.slice(0, 4).map((label) => ({ label, tone: 'info' as const })));
  if (routeLabels.length > 4) {
    attributes.push({ label: `+${routeLabels.length - 4} more routes`, tone: 'neutral' });
  }
  return attributes;
}

function locateAssignment(content: string, symbolName: string) {
  const regex = new RegExp(`^\\s*${escapeRegex(symbolName)}\\s*=`);
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (regex.test(lines[index])) {
      return { found: true, startLine: index + 1, endLine: index + 1, snippet: '' };
    }
  }
  return { found: false, startLine: 0, endLine: 0, snippet: '' };
}

function locateEntryAnchor(content: string, filePath: string, names: string[]) {
  for (const name of names) {
    const located = locateInFile(content, name, filePath);
    if (located.found) {
      return located;
    }
  }
  for (const name of names) {
    const located = locateAssignment(content, name);
    if (located.found) {
      return located;
    }
  }
  return { found: false, startLine: 0, endLine: 0, snippet: '' };
}

function createRouteNode(
  framework: string,
  filePath: string,
  content: string,
  name: string,
  routeLabels: string[],
  description: string,
): SubFunction {
  const located = locateInFile(content, name, filePath);
  return {
    name,
    description,
    file: filePath,
    drillDown: 1,
    startLine: located.found ? located.startLine : undefined,
    endLine: located.found ? located.endLine : undefined,
    kind: 'http-route',
    routeLabels,
    attributes: buildRouteAttributes(routeLabels, framework),
  };
}

function buildBridgeResult(options: {
  strategyId: string;
  label: string;
  framework: string;
  reason: string;
  entryFunctionName: string;
  entryDescription: string;
  entryFile: string;
  entryContent: string;
  entryAnchorCandidates: string[];
  entryAttributes: NodeAttribute[];
  routes: SubFunction[];
  filesScanned: number;
}): BridgeStrategyMatch {
  const entryLocation = options.entryFile
    ? locateEntryAnchor(options.entryContent, options.entryFile, options.entryAnchorCandidates)
    : { found: false, startLine: 0, endLine: 0, snippet: '' };

  return {
    result: {
      entryFunctionName: options.entryFunctionName,
      entryDescription: options.entryDescription,
      entryFile: options.entryFile || undefined,
      entryStartLine: entryLocation.found ? entryLocation.startLine : undefined,
      entryEndLine: entryLocation.found ? entryLocation.endLine : undefined,
      entryAttributes: options.entryAttributes,
      analysisMode: 'bridge',
      bridge: {
        strategyId: options.strategyId,
        label: options.label,
        framework: options.framework,
        reason: options.reason,
      },
      subFunctions: options.routes,
    },
    details: {
      strategyId: options.strategyId,
      label: options.label,
      framework: options.framework,
      reason: options.reason,
      rootCount: options.routes.length,
      filesScanned: options.filesScanned,
    },
  };
}

async function readContent(context: BridgeStrategyContext, filePath: string) {
  if (!filePath) {
    return '';
  }
  if (normalizePath(filePath) === normalizePath(context.entryFilePath)) {
    return context.entryFileContent || '';
  }
  try {
    return await context.fetchContent(filePath);
  } catch {
    return '';
  }
}

async function resolveEntryFromCandidates(context: BridgeStrategyContext, candidates: string[]): Promise<ResolvedEntryFile> {
  for (const filePath of uniq(candidates.map((item) => normalizePath(item)).filter(Boolean))) {
    if (!context.sourceFiles.includes(filePath)) {
      continue;
    }
    const content = await readContent(context, filePath);
    if (content) {
      return { filePath, content };
    }
  }
  if (context.entryFilePath) {
    return { filePath: normalizePath(context.entryFilePath), content: context.entryFileContent || '' };
  }
  return { filePath: '', content: '' };
}

async function resolveSpringEntry(context: BridgeStrategyContext) {
  return resolveEntryFromCandidates(context, [
    context.entryFilePath,
    ...context.sourceFiles.filter((filePath) => /Application\.java$/i.test(filePath)),
    ...context.sourceFiles.filter((filePath) => /src\/main\/java\/.*\.java$/i.test(filePath)),
  ]);
}

async function resolvePythonEntry(context: BridgeStrategyContext, pathPatterns: RegExp[], contentPatterns: RegExp[]) {
  const pythonFiles = context.sourceFiles.filter((filePath) => /\.py$/i.test(filePath));
  const ordered = uniq([
    context.entryFilePath,
    ...pythonFiles.filter((filePath) => pathPatterns.some((pattern) => pattern.test(filePath))),
    ...pythonFiles,
  ]);

  for (const filePath of ordered) {
    if (!filePath) {
      continue;
    }
    const content = await readContent(context, filePath);
    if (!content) {
      continue;
    }
    if (pathPatterns.some((pattern) => pattern.test(filePath)) || contentPatterns.some((pattern) => pattern.test(content))) {
      return { filePath: normalizePath(filePath), content };
    }
  }

  return resolveEntryFromCandidates(context, ordered);
}

function collectForwardDecoratorBlock(lines: string[], startIndex: number) {
  const collected: string[] = [];
  let openParens = 0;
  let index = startIndex;

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      if (openParens <= 0 && collected.length > 0) {
        break;
      }
      index += 1;
      continue;
    }

    if (!trimmed.startsWith('@') && !(openParens > 0) && collected.length > 0) {
      break;
    }
    if (!trimmed.startsWith('@') && collected.length === 0) {
      break;
    }

    collected.push(lines[index]);
    openParens += countChar(trimmed, '(') - countChar(trimmed, ')');
    index += 1;
  }

  return { text: collected.join('\n'), endLineIndex: Math.max(startIndex, index - 1) };
}

function collectLeadingAnnotations(lines: string[], lineIndex: number) {
  const collected: string[] = [];
  let saw = false;

  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      if (saw) {
        break;
      }
      continue;
    }

    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.endsWith('*/')) {
      continue;
    }

    const isAnnotationStart = trimmed.startsWith('@');
    const looksLikeValue = /[,(]$/.test(trimmed) || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed) || /^[)\]}]+,?$/.test(trimmed);
    if (!isAnnotationStart && !looksLikeValue && !saw) {
      break;
    }
    if (!isAnnotationStart && !looksLikeValue && saw) {
      break;
    }

    collected.unshift(lines[index]);
    if (isAnnotationStart) {
      saw = true;
    }
  }

  return saw ? collected.join('\n') : '';
}

function findNextJavaMethodSignature(lines: string[], startIndex: number) {
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 12); index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('@')) {
      return null;
    }

    let text = trimmed;
    let end = index;
    while (end + 1 < lines.length && !/[;{]/.test(text) && end < index + 8) {
      end += 1;
      text = `${text} ${lines[end].trim()}`.trim();
    }

    const match = text.match(
      /^(?:(?:public|private|protected|static|final|synchronized|abstract|default|native|strictfp)\s+)*[\w<>\[\], ?@.]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    );
    if (!match) {
      if (/[;{]/.test(text)) {
        return null;
      }
      continue;
    }

    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'new'].includes(match[1])) {
      continue;
    }
    return { methodName: match[1], lineIndex: index };
  }

  return null;
}

function findNextPythonFunctionSignature(lines: string[], startIndex: number) {
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 16); index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('@') || trimmed.startsWith('class ')) {
      return null;
    }

    let text = trimmed;
    let end = index;
    while (end + 1 < lines.length && !/:\s*$/.test(text) && end < index + 8) {
      end += 1;
      text = `${text} ${lines[end].trim()}`.trim();
    }

    const match = text.match(/^(?:async\s+def|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (match) {
      return { functionName: match[1], lineIndex: index };
    }
  }

  return null;
}

function parseSpringPaths(annotationBody: string) {
  const named = [...annotationBody.matchAll(/\b(?:value|path)\s*=\s*(\{[\s\S]*?\}|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)];
  if (named.length > 0) {
    return uniq(named.flatMap((match) => extractQuotedStrings(match[1])));
  }
  const direct = annotationBody.trim().match(/^(\{[\s\S]*\}|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
  return direct ? uniq(extractQuotedStrings(direct[1])) : [];
}

function parseSpringRequestMethods(annotationName: string, annotationBody: string) {
  if (annotationName !== 'RequestMapping') {
    return SPRING_HTTP_ANNOTATION_TO_METHOD[annotationName] || [];
  }
  return uniq([...annotationBody.matchAll(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)/g)].map((match) => match[1]));
}

function findSpringAnnotations(block: string) {
  const annotations: Array<{ name: string; body: string }> = [];
  for (const annotation of SPRING_METHOD_ANNOTATIONS) {
    const regex = new RegExp(`@${annotation}\\s*(?:\\(([\\s\\S]*?)\\))?`, 'g');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(block)) !== null) {
      annotations.push({ name: annotation, body: match[1] || '' });
    }
  }
  return annotations;
}

function parseSpringControllerClass(lines: string[]) {
  const classRegex = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(classRegex);
    if (!match) {
      continue;
    }
    const block = collectLeadingAnnotations(lines, index);
    if (!/@RestController\b/.test(block) && !/@Controller\b/.test(block)) {
      continue;
    }
    const basePaths = findSpringAnnotations(block)
      .filter((item) => item.name === 'RequestMapping')
      .flatMap((item) => parseSpringPaths(item.body));
    return { className: match[1], basePaths: basePaths.length ? basePaths : [''] } as SpringControllerClass;
  }
  return null;
}

async function discoverSpringRoutes(context: BridgeStrategyContext) {
  const javaFiles = context.sourceFiles.filter((filePath) => /\.java$/i.test(filePath) && /src\/main\/java\//i.test(filePath));
  const prioritized = javaFiles.filter((filePath) => /(^|\/)(controller|controllers|api|rest)(\/|$)|Controller\.java$/i.test(filePath));
  const candidateFiles = (prioritized.length ? prioritized : javaFiles).slice(0, 250);
  const routes: SubFunction[] = [];

  for (const filePath of candidateFiles) {
    const content = await readContent(context, filePath);
    if (!content || !/@(?:RestController|Controller)\b/.test(content)) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    const controllerClass = parseSpringControllerClass(lines);
    if (!controllerClass) {
      continue;
    }

    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim().startsWith('@')) {
        continue;
      }
      const block = collectForwardDecoratorBlock(lines, index);
      const annotations = findSpringAnnotations(block.text).filter((item) => SPRING_METHOD_ANNOTATIONS.includes(item.name));
      if (!annotations.length) {
        continue;
      }

      const signature = findNextJavaMethodSignature(lines, block.endLineIndex + 1);
      if (!signature) {
        continue;
      }

      const labels = uniq(
        annotations.flatMap((item) => {
          const basePaths = controllerClass.basePaths.length ? controllerClass.basePaths : [''];
          const methodPaths = parseSpringPaths(item.body);
          const methods = parseSpringRequestMethods(item.name, item.body);
          const fullPaths: string[] = [];
          for (const basePath of basePaths) {
            for (const methodPath of methodPaths.length ? methodPaths : ['']) {
              fullPaths.push(combineRoutePath(basePath, methodPath));
            }
          }
          return formatRouteLabels(fullPaths, methods);
        }),
      );

      routes.push(
        createRouteNode(
          'Spring Boot',
          filePath,
          content,
          `${controllerClass.className}::${signature.methodName}`,
          labels,
          labels.length ? `Spring Boot Controller 路由：${labels.join(' | ')}` : 'Spring Boot Controller 路由处理函数',
        ),
      );
      index = signature.lineIndex;
    }
  }

  return { routes, filesScanned: candidateFiles.length };
}

function parseNamedStringArg(callBody: string, argName: string) {
  const match = callBody.match(
    new RegExp(`\\b${escapeRegex(argName)}\\s*=\\s*(?:r|u|ur|rf|fr)?(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`, 'i'),
  );
  return match ? extractQuotedStrings(match[0])[0] || '' : '';
}

function parseFirstStringArg(callBody: string) {
  const match = callBody.match(/^\s*(?:r|u|ur|rf|fr)?(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/i);
  return match ? extractQuotedStrings(match[0])[0] || '' : '';
}

function parseMethodsArg(callBody: string) {
  const match = callBody.match(/\bmethods\s*=\s*(\[[\s\S]*?\]|\([\s\S]*?\))/i);
  return match ? uniq(extractQuotedStrings(match[1]).map((item) => item.toUpperCase()).filter(Boolean)) : [];
}

function parseFlaskBlueprintPrefixes(content: string) {
  const map = new Map<string, string>();
  const regex = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Blueprint\s*\(([\s\S]*?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    map.set(match[1], parseNamedStringArg(match[2], 'url_prefix') || '');
  }
  return map;
}

function parseFastApiRouterPrefixes(content: string) {
  const map = new Map<string, string>();
  const regex = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*APIRouter\s*\(([\s\S]*?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    map.set(match[1], parseNamedStringArg(match[2], 'prefix') || '');
  }
  return map;
}

function parseFlaskRoutes(blockText: string, prefixes: Map<string, string>) {
  const labels: string[] = [];
  const regex = /@([A-Za-z_][A-Za-z0-9_\.]*)\.route\s*\(([\s\S]*?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(blockText)) !== null) {
    const receiver = match[1].split('.').pop() || match[1];
    const path = parseNamedStringArg(match[2], 'rule') || parseFirstStringArg(match[2]) || '/';
    const methods = parseMethodsArg(match[2]);
    labels.push(...formatRouteLabels([combineRoutePath(prefixes.get(receiver) || '', path)], methods.length ? methods : ['GET']));
  }
  return uniq(labels);
}

function parseFastApiRoutes(blockText: string, prefixes: Map<string, string>) {
  const labels: string[] = [];
  const regex = /@([A-Za-z_][A-Za-z0-9_\.]*)\.(get|post|put|delete|patch|options|head|api_route|websocket)\s*\(([\s\S]*?)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(blockText)) !== null) {
    const receiver = match[1].split('.').pop() || match[1];
    const path = parseNamedStringArg(match[3], 'path') || parseFirstStringArg(match[3]) || '/';
    const methodName = match[2].toLowerCase();
    const methods = methodName === 'api_route' ? parseMethodsArg(match[3]) : methodName === 'websocket' ? ['WS'] : [methodName.toUpperCase()];
    labels.push(...formatRouteLabels([combineRoutePath(prefixes.get(receiver) || '', path)], methods.length ? methods : ['ANY']));
  }
  return uniq(labels);
}

function getPythonRouteFiles(context: BridgeStrategyContext) {
  const pythonFiles = context.sourceFiles.filter(
    (filePath) => /\.py$/i.test(filePath) && !/(^|\/)(tests?|migrations|__pycache__)(\/|$)/i.test(filePath),
  );
  const prioritized = pythonFiles.filter(
    (filePath) =>
      /(^|\/)(app|main|run|server|wsgi|asgi|api|routes?|routers?|views?)\.py$/i.test(filePath) ||
      /(^|\/)(api|routes?|routers?|views?)(\/|$)/i.test(filePath),
  );
  return uniq([...prioritized, ...pythonFiles]).slice(0, 260);
}

async function discoverFlaskRoutes(context: BridgeStrategyContext) {
  const candidateFiles = getPythonRouteFiles(context);
  const routes: SubFunction[] = [];
  for (const filePath of candidateFiles) {
    const content = await readContent(context, filePath);
    if (!content || !/\b(?:from\s+flask\s+import|import\s+flask\b|Flask\s*\(|Blueprint\s*\()/i.test(content)) {
      continue;
    }
    const prefixes = parseFlaskBlueprintPrefixes(content);
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim().startsWith('@')) {
        continue;
      }
      const block = collectForwardDecoratorBlock(lines, index);
      const labels = parseFlaskRoutes(block.text, prefixes);
      if (!labels.length) {
        continue;
      }
      const signature = findNextPythonFunctionSignature(lines, block.endLineIndex + 1);
      if (!signature) {
        continue;
      }
      routes.push(createRouteNode('Flask', filePath, content, signature.functionName, labels, `Flask 路由处理函数：${labels.join(' | ')}`));
      index = signature.lineIndex;
    }
  }
  return { routes, filesScanned: candidateFiles.length };
}

async function discoverFastApiRoutes(context: BridgeStrategyContext) {
  const candidateFiles = getPythonRouteFiles(context);
  const routes: SubFunction[] = [];
  for (const filePath of candidateFiles) {
    const content = await readContent(context, filePath);
    if (!content || !/\b(?:from\s+fastapi\s+import|import\s+fastapi\b|FastAPI\s*\(|APIRouter\s*\()/i.test(content)) {
      continue;
    }
    const prefixes = parseFastApiRouterPrefixes(content);
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim().startsWith('@')) {
        continue;
      }
      const block = collectForwardDecoratorBlock(lines, index);
      const labels = parseFastApiRoutes(block.text, prefixes);
      if (!labels.length) {
        continue;
      }
      const signature = findNextPythonFunctionSignature(lines, block.endLineIndex + 1);
      if (!signature) {
        continue;
      }
      routes.push(createRouteNode('FastAPI', filePath, content, signature.functionName, labels, `FastAPI 路由处理函数：${labels.join(' | ')}`));
      index = signature.lineIndex;
    }
  }
  return { routes, filesScanned: candidateFiles.length };
}

function resolvePythonModuleFile(moduleExpr: string, currentFilePath: string, sourceFiles: string[]) {
  const trimmed = moduleExpr.trim();
  if (!trimmed) {
    return '';
  }

  let modulePath = '';
  if (trimmed.startsWith('.')) {
    const dots = trimmed.match(/^\.+/)?.[0].length || 0;
    const remainder = trimmed.slice(dots).replace(/\./g, '/');
    const baseParts = dirname(currentFilePath).split('/').filter(Boolean);
    modulePath = [
      ...baseParts.slice(0, Math.max(0, baseParts.length - Math.max(dots - 1, 0))),
      ...remainder.split('/').filter(Boolean),
    ].join('/');
  } else {
    modulePath = trimmed.replace(/\./g, '/');
  }

  const candidates = [`${modulePath}.py`, `${modulePath}/__init__.py`].map((item) => normalizePath(item));
  for (const candidate of candidates) {
    const direct = sourceFiles.find((filePath) => normalizePath(filePath) === candidate);
    if (direct) {
      return direct;
    }
    const suffix = sourceFiles.find((filePath) => normalizePath(filePath).endsWith(`/${candidate}`));
    if (suffix) {
      return suffix;
    }
  }

  return '';
}

function parsePythonImports(content: string, currentFilePath: string, sourceFiles: string[]): PythonImportMap {
  const symbolFiles = new Map<string, string>();
  const moduleFiles = new Map<string, string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) {
      continue;
    }

    const fromMatch = line.match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
    if (fromMatch) {
      const moduleExpr = fromMatch[1];
      for (const imported of fromMatch[2].split(',').map((item) => item.trim()).filter(Boolean)) {
        const match = imported.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/);
        if (!match || match[1] === '*') {
          continue;
        }
        const originalName = match[1];
        const alias = match[2] || originalName;
        const submoduleFile = resolvePythonModuleFile(
          moduleExpr === '.' ? `.${originalName}` : `${moduleExpr}.${originalName}`,
          currentFilePath,
          sourceFiles,
        );
        if (submoduleFile) {
          moduleFiles.set(alias, submoduleFile);
          continue;
        }
        const moduleFile = resolvePythonModuleFile(moduleExpr, currentFilePath, sourceFiles);
        if (moduleFile) {
          symbolFiles.set(alias, moduleFile);
        }
      }
      continue;
    }

    const importMatch = line.match(/^import\s+(.+)$/);
    if (!importMatch) {
      continue;
    }
    for (const imported of importMatch[1].split(',').map((item) => item.trim()).filter(Boolean)) {
      const match = imported.match(/^([A-Za-z_][A-Za-z0-9_\.]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/);
      if (!match) {
        continue;
      }
      const moduleFile = resolvePythonModuleFile(match[1], currentFilePath, sourceFiles);
      if (moduleFile) {
        moduleFiles.set(match[2] || match[1].split('.').pop() || match[1], moduleFile);
      }
    }
  }

  return { symbolFiles, moduleFiles };
}

function extractBalanced(content: string, openIndex: number) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;

  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (!inDouble && char === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) {
      continue;
    }
    if (char === '(') {
      depth += 1;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return { body: content.slice(openIndex + 1, index), endIndex: index };
      }
    }
  }

  return null;
}

function splitTopLevelArgs(input: string) {
  const args: string[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (!inDouble && char === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) {
      continue;
    }
    if (char === '(') round += 1;
    if (char === ')') round -= 1;
    if (char === '[') square += 1;
    if (char === ']') square -= 1;
    if (char === '{') curly += 1;
    if (char === '}') curly -= 1;
    if (char === ',' && round === 0 && square === 0 && curly === 0) {
      args.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }

  const tail = input.slice(start).trim();
  if (tail) {
    args.push(tail);
  }
  return args;
}

function extractCallBodies(content: string, names: string[]) {
  const results: Array<{ name: string; body: string }> = [];
  for (let index = 0; index < content.length; index += 1) {
    for (const name of names) {
      if (!content.startsWith(name, index)) {
        continue;
      }
      const previous = content[index - 1];
      if (previous && /[A-Za-z0-9_.]/.test(previous)) {
        continue;
      }
      const openIndex = index + name.length;
      if (content[openIndex] !== '(') {
        continue;
      }
      const extracted = extractBalanced(content, openIndex);
      if (!extracted) {
        continue;
      }
      results.push({ name, body: extracted.body });
      index = extracted.endIndex;
      break;
    }
  }
  return results;
}

function parseDjangoRouteRecords(content: string) {
  const records: Array<{ routePath: string; targetExpression?: string; includeModule?: string }> = [];
  for (const call of extractCallBodies(content, ['path', 're_path'])) {
    const args = splitTopLevelArgs(call.body);
    if (args.length < 2) {
      continue;
    }
    const rawPath = extractQuotedStrings(args[0])[0] || '';
    const routePath = normalizeRoutePath(rawPath || '/');
    const targetExpression = args[1].trim();
    if (/^include\s*\(/.test(targetExpression)) {
      const includeModule = extractQuotedStrings(targetExpression).find(Boolean) || '';
      if (includeModule) {
        records.push({ routePath, includeModule });
      }
      continue;
    }
    records.push({ routePath, targetExpression });
  }
  return records;
}

function findPythonClassHttpMethods(content: string, className: string) {
  const lines = content.split(/\r?\n/);
  const classRegex = new RegExp(`^\\s*class\\s+${escapeRegex(className)}\\b`);
  let classStart = -1;
  let classIndent = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (!classRegex.test(lines[index])) {
      continue;
    }
    classStart = index;
    classIndent = (lines[index].match(/^(\s*)/)?.[1] || '').length;
    break;
  }

  if (classStart < 0) {
    return [];
  }

  const methods: string[] = [];
  const methodRegex = new RegExp(`^\\s*(?:async\\s+def|def)\\s+(${DJANGO_HTTP_METHODS.join('|')})\\s*\\(`, 'i');
  for (let index = classStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    const indent = (line.match(/^(\s*)/)?.[1] || '').length;
    if (indent <= classIndent) {
      break;
    }
    const match = line.match(methodRegex);
    if (match) {
      methods.push(match[1].toLowerCase());
    }
  }

  return uniq(methods);
}

async function findPythonSymbolFile(
  context: BridgeStrategyContext,
  symbolName: string,
  preferredFiles: string[],
  kind: 'class' | 'function',
) {
  const regex =
    kind === 'class'
      ? new RegExp(`^\\s*class\\s+${escapeRegex(symbolName)}\\b`, 'm')
      : new RegExp(`^\\s*(?:async\\s+def|def)\\s+${escapeRegex(symbolName)}\\s*\\(`, 'm');
  const candidates = uniq([
    ...preferredFiles.filter((filePath) => /\.py$/i.test(filePath)),
    ...context.sourceFiles.filter((filePath) => /\.py$/i.test(filePath)),
  ]).slice(0, 260);

  for (const filePath of candidates) {
    const content = await readContent(context, filePath);
    if (content && regex.test(content)) {
      return filePath;
    }
  }

  return '';
}

async function resolveDjangoTarget(
  context: BridgeStrategyContext,
  targetExpression: string,
  importMap: PythonImportMap,
  urlsFilePath: string,
) {
  const classViewMatch = targetExpression.match(/^([A-Za-z_][A-Za-z0-9_\.]*)\.as_view\s*\(/);
  const baseExpression = classViewMatch ? classViewMatch[1] : targetExpression.replace(/\s+/g, '');
  const parts = baseExpression.split('.').filter(Boolean);
  const preferredFiles = [joinPath(dirname(urlsFilePath), 'views.py'), joinPath(dirname(urlsFilePath), 'api.py'), joinPath(dirname(urlsFilePath), 'handlers.py')];
  let resolvedFile = '';
  let symbolName = '';

  if (parts.length >= 2 && importMap.moduleFiles.has(parts[0])) {
    resolvedFile = importMap.moduleFiles.get(parts[0]) || '';
    symbolName = parts[parts.length - 1];
  } else if (parts.length === 1 && importMap.symbolFiles.has(parts[0])) {
    resolvedFile = importMap.symbolFiles.get(parts[0]) || '';
    symbolName = parts[0];
  } else if (parts.length >= 2) {
    resolvedFile = resolvePythonModuleFile(parts.slice(0, -1).join('.'), urlsFilePath, context.sourceFiles);
    symbolName = parts[parts.length - 1];
  } else {
    symbolName = parts[0] || '';
  }

  if (!resolvedFile && symbolName) {
    resolvedFile = await findPythonSymbolFile(context, symbolName, preferredFiles, classViewMatch ? 'class' : 'function');
  }

  return resolvedFile && symbolName ? { filePath: resolvedFile, symbolName, classBased: !!classViewMatch } : null;
}

async function resolveDjangoRootUrls(context: BridgeStrategyContext) {
  const settingsFiles = context.sourceFiles.filter((filePath) => /(^|\/)settings\.py$/i.test(filePath));
  const resolved: string[] = [];

  for (const filePath of settingsFiles) {
    const content = await readContent(context, filePath);
    const match = content.match(/ROOT_URLCONF\s*=\s*['"]([\w.]+)['"]/);
    if (!match) {
      continue;
    }
    const urlsFile = resolvePythonModuleFile(match[1], filePath, context.sourceFiles);
    if (urlsFile) {
      resolved.push(urlsFile);
    }
  }

  if (resolved.length) {
    return uniq(resolved);
  }

  for (const entryFile of [context.entryFilePath, ...context.sourceFiles.filter((filePath) => /(^|\/)(wsgi|asgi)\.py$/i.test(filePath))]) {
    if (!entryFile) {
      continue;
    }
    const sibling = joinPath(dirname(entryFile), 'urls.py');
    if (context.sourceFiles.includes(sibling)) {
      resolved.push(sibling);
    }
  }

  if (resolved.length) {
    return uniq(resolved);
  }

  return context.sourceFiles.filter((filePath) => /(^|\/)urls\.py$/i.test(filePath)).slice(0, 8);
}

async function discoverDjangoRoutes(context: BridgeStrategyContext) {
  const rootUrls = await resolveDjangoRootUrls(context);
  const routes: SubFunction[] = [];
  const visited = new Set<string>();
  const scannedFiles = new Set<string>();
  const seenRouteKeys = new Set<string>();

  const walk = async (urlsFilePath: string, prefix: string) => {
    const visitKey = `${urlsFilePath}|${prefix}`;
    if (visited.has(visitKey)) {
      return;
    }
    visited.add(visitKey);

    const content = await readContent(context, urlsFilePath);
    if (!content) {
      return;
    }
    scannedFiles.add(urlsFilePath);
    const importMap = parsePythonImports(content, urlsFilePath, context.sourceFiles);

    for (const record of parseDjangoRouteRecords(content)) {
      const fullPath = combineRoutePath(prefix, record.routePath);
      if (record.includeModule) {
        const nested = resolvePythonModuleFile(record.includeModule, urlsFilePath, context.sourceFiles);
        if (nested) {
          await walk(nested, fullPath);
        }
        continue;
      }
      if (!record.targetExpression) {
        continue;
      }

      const target = await resolveDjangoTarget(context, record.targetExpression, importMap, urlsFilePath);
      if (!target) {
        continue;
      }
      const targetContent = await readContent(context, target.filePath);
      if (!targetContent) {
        continue;
      }

      if (target.classBased) {
        const methods = findPythonClassHttpMethods(targetContent, target.symbolName);
        const methodNames = methods.length ? methods : ['dispatch'];
        for (const methodName of methodNames) {
          const labels =
            methodName === 'dispatch'
              ? formatRouteLabels([fullPath], ['ANY'])
              : formatRouteLabels([fullPath], [methodName.toUpperCase()]);
          const nodeName = `${target.symbolName}::${methodName}`;
          const routeKey = `${target.filePath}|${nodeName}|${labels.join('|')}`;
          if (seenRouteKeys.has(routeKey)) {
            continue;
          }
          seenRouteKeys.add(routeKey);
          routes.push(createRouteNode('Django', target.filePath, targetContent, nodeName, labels, `Django 路由处理方法：${labels.join(' | ')}`));
        }
        continue;
      }

      const labels = formatRouteLabels([fullPath], ['ANY']);
      const routeKey = `${target.filePath}|${target.symbolName}|${labels.join('|')}`;
      if (seenRouteKeys.has(routeKey)) {
        continue;
      }
      seenRouteKeys.add(routeKey);
      routes.push(createRouteNode('Django', target.filePath, targetContent, target.symbolName, labels, `Django 路由处理函数：${labels.join(' | ')}`));
    }
  };

  for (const rootUrl of rootUrls) {
    await walk(rootUrl, '/');
  }

  return { routes, filesScanned: scannedFiles.size };
}

function isSpringProject(context: BridgeStrategyContext) {
  const javaProject = (context.aiResult.mainLanguage || '').toLowerCase().includes('java');
  const techStack = context.aiResult.techStack || [];
  const byAi = includesToken(techStack, ['spring boot', 'springboot', 'spring', 'spring mvc']);
  const byFiles =
    context.sourceFiles.some((filePath) => /(^|\/)(pom\.xml|build\.gradle|build\.gradle\.kts)$/.test(filePath)) &&
    context.sourceFiles.some((filePath) => /src\/main\/java\//i.test(filePath)) &&
    context.sourceFiles.some((filePath) => /src\/main\/resources\/application\.(ya?ml|properties)$/i.test(filePath));
  return javaProject && (byAi || byFiles);
}

function isFlaskProject(context: BridgeStrategyContext) {
  const pythonProject = (context.aiResult.mainLanguage || '').toLowerCase().includes('python');
  const techStack = context.aiResult.techStack || [];
  return pythonProject && (includesToken(techStack, ['flask']) || context.sourceFiles.some((filePath) => /(^|\/)(app|run|wsgi)\.py$/i.test(filePath)));
}

function isFastApiProject(context: BridgeStrategyContext) {
  const pythonProject = (context.aiResult.mainLanguage || '').toLowerCase().includes('python');
  const techStack = context.aiResult.techStack || [];
  return pythonProject && (includesToken(techStack, ['fastapi']) || context.sourceFiles.some((filePath) => /(^|\/)(main|app|asgi)\.py$/i.test(filePath)));
}

function isDjangoProject(context: BridgeStrategyContext) {
  const pythonProject = (context.aiResult.mainLanguage || '').toLowerCase().includes('python');
  const techStack = context.aiResult.techStack || [];
  const byAi = includesToken(techStack, ['django', 'django rest framework', 'drf']);
  const byFiles =
    context.sourceFiles.some((filePath) => /(^|\/)manage\.py$/i.test(filePath)) &&
    context.sourceFiles.some((filePath) => /(^|\/)urls\.py$/i.test(filePath)) &&
    context.sourceFiles.some((filePath) => /(^|\/)(wsgi|asgi|settings)\.py$/i.test(filePath));
  return pythonProject && (byAi || byFiles);
}

const springBridge: BridgeStrategy = {
  id: 'spring-boot-controller',
  label: 'Spring Boot Controller 桥接',
  framework: 'Spring Boot',
  async tryBuild(context) {
    if (!isSpringProject(context)) {
      return null;
    }

    const { routes, filesScanned } = await discoverSpringRoutes(context);
    if (!routes.length) {
      return null;
    }
    const entry = await resolveSpringEntry(context);

    return buildBridgeResult({
      strategyId: 'spring-boot-controller',
      label: 'Spring Boot Controller 桥接',
      framework: 'Spring Boot',
      reason: 'Spring Boot 请求会先由框架分发，再进入 Controller 处理方法。',
      entryFunctionName: 'SpringBoot::HttpBridge',
      entryDescription: '框架桥接入口，请求先进入 Spring MVC，再分发到 Controller 处理方法。',
      entryFile: entry.filePath,
      entryContent: entry.content,
      entryAnchorCandidates: ['main', 'run'],
      entryAttributes: [
        { label: '桥接模式', tone: 'warning' },
        { label: 'Spring Boot', tone: 'success' },
      ],
      routes,
      filesScanned,
    });
  },
};

const flaskBridge: BridgeStrategy = {
  id: 'python-flask-route',
  label: 'Flask 路由桥接',
  framework: 'Flask',
  async tryBuild(context) {
    if (!isFlaskProject(context)) {
      return null;
    }

    const { routes, filesScanned } = await discoverFlaskRoutes(context);
    if (!routes.length) {
      return null;
    }
    const entry = await resolvePythonEntry(
      context,
      [/(^|\/)wsgi\.py$/i, /(^|\/)(app|run|main|server)\.py$/i],
      [/\bFlask\s*\(/, /\bBlueprint\s*\(/, /\bapplication\s*=/, /\bapp\s*=/],
    );
    const wsgiEntry = fileName(entry.filePath).toLowerCase() === 'wsgi.py';

    return buildBridgeResult({
      strategyId: 'python-flask-route',
      label: 'Flask 路由桥接',
      framework: 'Flask',
      reason: 'Flask 请求会先经过 WSGI 或 Flask 应用对象，再分发到路由处理函数。',
      entryFunctionName: wsgiEntry ? 'Flask::WsgiBridge' : 'Flask::HttpBridge',
      entryDescription: wsgiEntry
        ? '框架桥接入口，请求先进入 WSGI application，再分发到 Flask 路由处理函数。'
        : '框架桥接入口，请求先进入 Flask application，再分发到路由处理函数。',
      entryFile: entry.filePath,
      entryContent: entry.content,
      entryAnchorCandidates: ['application', 'app', 'create_app'],
      entryAttributes: [
        { label: '桥接模式', tone: 'warning' },
        { label: 'Flask', tone: 'success' },
      ],
      routes,
      filesScanned,
    });
  },
};

const fastApiBridge: BridgeStrategy = {
  id: 'python-fastapi-route',
  label: 'FastAPI 路由桥接',
  framework: 'FastAPI',
  async tryBuild(context) {
    if (!isFastApiProject(context)) {
      return null;
    }

    const { routes, filesScanned } = await discoverFastApiRoutes(context);
    if (!routes.length) {
      return null;
    }
    const entry = await resolvePythonEntry(
      context,
      [/(^|\/)asgi\.py$/i, /(^|\/)(main|app|server|wsgi)\.py$/i],
      [/\bFastAPI\s*\(/, /\bAPIRouter\s*\(/, /\bapplication\s*=/, /\bapp\s*=/],
    );
    const asgiEntry = fileName(entry.filePath).toLowerCase() === 'asgi.py';

    return buildBridgeResult({
      strategyId: 'python-fastapi-route',
      label: 'FastAPI 路由桥接',
      framework: 'FastAPI',
      reason: 'FastAPI 请求会先经过 ASGI 或应用对象，再分发到路由处理函数。',
      entryFunctionName: asgiEntry ? 'FastAPI::AsgiBridge' : 'FastAPI::HttpBridge',
      entryDescription: asgiEntry
        ? '框架桥接入口，请求先进入 ASGI application，再分发到 FastAPI 路由处理函数。'
        : '框架桥接入口，请求先进入 FastAPI application，再分发到路由处理函数。',
      entryFile: entry.filePath,
      entryContent: entry.content,
      entryAnchorCandidates: ['application', 'app', 'create_app'],
      entryAttributes: [
        { label: '桥接模式', tone: 'warning' },
        { label: 'FastAPI', tone: 'success' },
      ],
      routes,
      filesScanned,
    });
  },
};

const djangoBridge: BridgeStrategy = {
  id: 'python-django-route',
  label: 'Django 路由桥接',
  framework: 'Django',
  async tryBuild(context) {
    if (!isDjangoProject(context)) {
      return null;
    }

    const { routes, filesScanned } = await discoverDjangoRoutes(context);
    if (!routes.length) {
      return null;
    }
    const entry = await resolvePythonEntry(
      context,
      [/(^|\/)wsgi\.py$/i, /(^|\/)asgi\.py$/i, /(^|\/)manage\.py$/i],
      [/\bget_wsgi_application\b/, /\bget_asgi_application\b/, /\bdjango\.core\./, /\bapplication\s*=/],
    );
    const entryBase = fileName(entry.filePath).toLowerCase();
    const entryFunctionName =
      entryBase === 'asgi.py' ? 'Django::AsgiBridge' : entryBase === 'wsgi.py' ? 'Django::WsgiBridge' : 'Django::HttpBridge';

    return buildBridgeResult({
      strategyId: 'python-django-route',
      label: 'Django 路由桥接',
      framework: 'Django',
      reason: 'Django 请求会先经过 URLConf 和 WSGI 或 ASGI 入口，再分发到视图处理函数。',
      entryFunctionName,
      entryDescription: '框架桥接入口，请求先进入 URLConf 和 WSGI/ASGI 层，再分发到 Django 视图处理函数。',
      entryFile: entry.filePath,
      entryContent: entry.content,
      entryAnchorCandidates: ['application', 'get_wsgi_application', 'get_asgi_application'],
      entryAttributes: [
        { label: '桥接模式', tone: 'warning' },
        { label: 'Django', tone: 'success' },
      ],
      routes,
      filesScanned,
    });
  },
};

const BRIDGE_STRATEGIES: BridgeStrategy[] = [springBridge, fastApiBridge, flaskBridge, djangoBridge];

export async function buildBridgeAnalysis(context: BridgeStrategyContext): Promise<BridgeStrategyMatch | null> {
  const cache = new Map<string, Promise<string>>();
  const cachedContext: BridgeStrategyContext = {
    ...context,
    fetchContent(filePath: string) {
      const normalized = normalizePath(filePath);
      if (!cache.has(normalized)) {
        cache.set(normalized, context.fetchContent(normalized));
      }
      return cache.get(normalized)!;
    },
  };

  for (const strategy of BRIDGE_STRATEGIES) {
    const match = await strategy.tryBuild(cachedContext);
    if (match) {
      return match;
    }
  }

  return null;
}
