import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Loader2 } from 'lucide-react';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import { FunctionModule, NodeAttribute, SubFunction, SubFunctionAnalysisResult } from '../lib/ai';
import { localizeModuleName, makeFunctionKey } from '../lib/moduleGrouping';

export interface PanoramaNodeRef {
  id: string;
  name: string;
  file: string;
  startLine?: number;
  endLine?: number;
}

export interface PanoramaDrillTarget extends PanoramaNodeRef {
  drillDown?: number;
  stopReason?: string;
}

interface PanoramaProps {
  data: SubFunctionAnalysisResult | null;
  entryFile: string;
  moduleMap: Map<string, FunctionModule>;
  selectedModuleId: string | null;
  drillingNodeId?: string | null;
  viewportRef?: RefObject<HTMLDivElement>;
  layoutRef?: RefObject<HTMLDivElement>;
  onNodeSelect?: (node: PanoramaNodeRef) => void;
  onNodeDrillDown?: (node: PanoramaDrillTarget) => void;
}

interface LayoutNode extends PanoramaDrillTarget {
  x: number;
  y: number;
  description: string;
  isEntry: boolean;
  stopReason?: string;
  attributes?: NodeAttribute[];
  routeLabels?: string[];
  kind?: string;
  hasLoadedChildren: boolean;
  isCollapsed: boolean;
}

const DEFAULT_CARD_WIDTH = 320;
const DEFAULT_CARD_HEIGHT = 232;
const MIN_CARD_WIDTH = 220;
const MAX_CARD_WIDTH = 560;
const MIN_CARD_HEIGHT = 132;
const MAX_CARD_HEIGHT = 460;
const VERTICAL_SPACING = 60;
const HORIZONTAL_SPACING = 44;

function getAttributeClass(tone?: NodeAttribute['tone']) {
  if (tone === 'info') {
    return 'border-blue-200 bg-blue-50 text-blue-700';
  }
  if (tone === 'success') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  }
  if (tone === 'warning') {
    return 'border-amber-200 bg-amber-50 text-amber-700';
  }
  return 'border-gray-200 bg-gray-50 text-gray-600';
}

const ROUTE_LABEL_PATTERN = /^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD|ANY|WS)\s+\/?/i;

function extractRouteLabels(node: Pick<LayoutNode, 'attributes' | 'routeLabels'>) {
  if (node.routeLabels?.length) {
    return node.routeLabels;
  }

  return (node.attributes || [])
    .map((attribute) => attribute.label)
    .filter((label) => ROUTE_LABEL_PATTERN.test(label));
}

function filterDisplayAttributes(attributes: NodeAttribute[] | undefined, routeLabels: string[]) {
  if (!attributes?.length) {
    return [];
  }

  const routeSet = new Set(routeLabels);
  return attributes.filter((attribute) => !routeSet.has(attribute.label));
}

function collectExpandableNodeIds(data: SubFunctionAnalysisResult | null) {
  if (!data) {
    return [] as string[];
  }

  const ids: string[] = [];
  if (data.subFunctions.length) {
    ids.push('entry');
  }

  const walk = (subs: SubFunction[], prefix: string) => {
    subs.forEach((sub, index) => {
      const id = `${prefix}-${index}`;
      if (sub.children?.length) {
        ids.push(id);
        walk(sub.children, id);
      }
    });
  };

  walk(data.subFunctions, 'sub');
  return ids;
}

function areSetsEqual(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

function shouldShowDrillButton(node: LayoutNode) {
  if (node.isEntry || node.hasLoadedChildren) {
    return false;
  }

  if (node.drillDown !== 0 && node.drillDown !== 1) {
    return false;
  }

  return node.stopReason !== 'system_function' && node.stopReason !== 'no_children';
}

function buildTreeLayout(
  data: SubFunctionAnalysisResult,
  entryFile: string,
  cardWidth: number,
  cardHeight: number,
  collapsedNodeIds: Set<string>,
): {
  nodes: LayoutNode[];
  edges: Array<{ id: string; from: string; to: string; x1: number; y1: number; x2: number; y2: number }>;
  layoutWidth: number;
  layoutHeight: number;
} {
  const nodes: LayoutNode[] = [];
  const edges: Array<{ id: string; from: string; to: string; x1: number; y1: number; x2: number; y2: number }> = [];
  let currentX = 24;

  nodes.push({
    id: 'entry',
    x: currentX,
    y: 24,
    name: data.entryFunctionName === 'Analyzing...' ? '正在分析入口函数...' : data.entryFunctionName,
    file: data.entryFile || entryFile,
    startLine: data.entryStartLine,
    endLine: data.entryEndLine,
    description:
      data.entryDescription ||
      (data.entryFunctionName === 'Analyzing...' ? 'AI 正在提取入口函数信息。' : '项目入口函数'),
    attributes: data.entryAttributes,
    kind: data.analysisMode === 'bridge' ? 'bridge-entry' : 'entry',
    isEntry: true,
    hasLoadedChildren: data.subFunctions.length > 0,
    isCollapsed: collapsedNodeIds.has('entry'),
  });

  const entryCenterX = currentX + cardWidth / 2;
  const entryBottomY = 24 + cardHeight;
  currentX += cardWidth + HORIZONTAL_SPACING;
  const cursor = { x: currentX, y: 24 };

  function addSubNodes(subs: SubFunction[], parentId: string, parentCenterX: number, parentBottomY: number, prefix: string) {
    subs.forEach((sub, index) => {
      const id = `${prefix}-${index}`;
      const hasLoadedChildren = !!sub.children?.length;
      const isCollapsed = hasLoadedChildren && collapsedNodeIds.has(id);

      nodes.push({
        id,
        x: cursor.x,
        y: cursor.y,
        name: sub.name,
        file: sub.file,
        startLine: sub.startLine,
        endLine: sub.endLine,
        description: sub.description,
        attributes: sub.attributes,
        routeLabels: sub.routeLabels,
        kind: sub.kind,
        isEntry: false,
        drillDown: sub.drillDown,
        stopReason: sub.stopReason,
        hasLoadedChildren,
        isCollapsed,
      });

      edges.push({
        id: `edge-${id}`,
        from: parentId,
        to: id,
        x1: parentCenterX,
        y1: parentBottomY,
        x2: cursor.x,
        y2: cursor.y + cardHeight / 2,
      });

      const nodeCenterX = cursor.x + cardWidth / 2;
      const nodeBottomY = cursor.y + cardHeight;
      cursor.y += cardHeight + VERTICAL_SPACING;

      if (hasLoadedChildren && !isCollapsed) {
        const savedX = cursor.x;
        cursor.x += cardWidth + HORIZONTAL_SPACING;
        addSubNodes(sub.children || [], id, nodeCenterX, nodeBottomY, id);
        cursor.x = savedX;
      }
    });
  }

  if (!collapsedNodeIds.has('entry')) {
    addSubNodes(data.subFunctions, 'entry', entryCenterX, entryBottomY, 'sub');
  }

  const maxX = nodes.length ? Math.max(...nodes.map((node) => node.x + cardWidth)) : 0;
  const maxY = nodes.length ? Math.max(...nodes.map((node) => node.y + cardHeight)) : 0;

  return {
    nodes,
    edges,
    layoutHeight: Math.max(960, maxY + 80),
    layoutWidth: Math.max(1920, maxX + 96),
  };
}

export default function Panorama({
  data,
  entryFile,
  moduleMap,
  selectedModuleId,
  drillingNodeId = null,
  viewportRef,
  layoutRef,
  onNodeSelect,
  onNodeDrillDown,
}: PanoramaProps) {
  const [cardSize, setCardSize] = useState({ width: DEFAULT_CARD_WIDTH, height: DEFAULT_CARD_HEIGHT });
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(() => new Set());

  const expandableNodeIds = useMemo(() => collectExpandableNodeIds(data), [data]);
  const expandableNodeIdSet = useMemo(() => new Set(expandableNodeIds), [expandableNodeIds]);

  useEffect(() => {
    setCollapsedNodeIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (expandableNodeIdSet.has(id)) {
          next.add(id);
        }
      }

      return areSetsEqual(prev, next) ? prev : next;
    });
  }, [expandableNodeIdSet]);

  const layout = useMemo(
    () => (data ? buildTreeLayout(data, entryFile, cardSize.width, cardSize.height, collapsedNodeIds) : null),
    [data, entryFile, cardSize.height, cardSize.width, collapsedNodeIds],
  );

  const layoutNodeMap = useMemo(
    () => new Map((layout?.nodes || []).map((node) => [node.id, node])),
    [layout],
  );

  if (!layout) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-sm bg-gray-50/50">
        等待函数分析...
      </div>
    );
  }

  const isDimmed = (name: string, file: string) => {
    if (!selectedModuleId) {
      return false;
    }
    const module = moduleMap.get(makeFunctionKey(name, file));
    return module?.id !== selectedModuleId;
  };

  const updateCardSize = (nextWidth: number, nextHeight: number) => {
    setCardSize({
      width: Math.max(MIN_CARD_WIDTH, Math.min(MAX_CARD_WIDTH, nextWidth)),
      height: Math.max(MIN_CARD_HEIGHT, Math.min(MAX_CARD_HEIGHT, nextHeight)),
    });
  };

  const adjustCardSize = (widthDelta: number, heightDelta: number) => {
    updateCardSize(cardSize.width + widthDelta, cardSize.height + heightDelta);
  };

  const handleResizeStart = (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = cardSize.width;
    const startHeight = cardSize.height;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateCardSize(startWidth + (moveEvent.clientX - startX), startHeight + (moveEvent.clientY - startY));
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const handleToggleNode = (nodeId: string) => {
    if (!expandableNodeIdSet.has(nodeId)) {
      return;
    }

    setCollapsedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  const handleExpandAll = () => {
    setCollapsedNodeIds(new Set());
  };

  const handleCollapseAll = () => {
    setCollapsedNodeIds(new Set(expandableNodeIds));
  };

  return (
    <div className="h-full w-full bg-gray-50/50 overflow-hidden relative flex flex-col">
      <div className="shrink-0 px-3 py-2 flex items-center justify-between gap-4 text-[10px] text-gray-500 border-b border-gray-100 bg-white/80">
        <div className="flex items-center gap-4 flex-wrap">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            建议下钻
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-yellow-400" />
            下钻待确认
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-gray-300" />
            无需下钻
          </span>
        </div>
        <div className="shrink-0 flex items-center gap-2 flex-wrap justify-end">
          <button
            type="button"
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[10px] font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300"
            onClick={handleExpandAll}
            disabled={expandableNodeIds.length === 0}
          >
            全部展开
          </button>
          <button
            type="button"
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[10px] font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300"
            onClick={handleCollapseAll}
            disabled={expandableNodeIds.length === 0}
          >
            全部收起
          </button>
          <span className="text-[10px] text-gray-400">卡片 {cardSize.width} x {cardSize.height}</span>
          <button
            type="button"
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[10px] font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50"
            onClick={() => adjustCardSize(-36, -28)}
          >
            缩小
          </button>
          <button
            type="button"
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[10px] font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50"
            onClick={() => updateCardSize(DEFAULT_CARD_WIDTH, DEFAULT_CARD_HEIGHT)}
          >
            重置
          </button>
          <button
            type="button"
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[10px] font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50"
            onClick={() => adjustCardSize(36, 28)}
          >
            放大
          </button>
        </div>
      </div>

      <div ref={viewportRef} className="flex-1 min-h-0 overflow-hidden">
        <TransformWrapper initialScale={1} minScale={0.1} maxScale={4} centerOnInit={false} wheel={{ step: 0.1 }}>
          <TransformComponent wrapperStyle={{ width: '100%', height: '100%' }}>
            <div
              ref={layoutRef}
              data-panorama-layout="true"
              className="relative"
              style={{ width: layout.layoutWidth, height: layout.layoutHeight }}
            >
              <svg className="absolute top-0 left-0 w-full h-full pointer-events-none">
                {layout.edges.map((edge) => {
                  const fromNode = layoutNodeMap.get(edge.from);
                  const toNode = layoutNodeMap.get(edge.to);
                  const dimmed =
                    !!selectedModuleId &&
                    !!fromNode &&
                    !!toNode &&
                    isDimmed(fromNode.name, fromNode.file) &&
                    isDimmed(toNode.name, toNode.file);
                  const path = `M ${edge.x1} ${edge.y1} V ${edge.y2} H ${edge.x2}`;

                  return (
                    <path
                      key={edge.id}
                      d={path}
                      fill="none"
                      stroke={dimmed ? '#d1d5db' : '#9ca3af'}
                      strokeWidth="2"
                      strokeDasharray="5,5"
                      opacity={dimmed ? 0.35 : 1}
                    />
                  );
                })}
              </svg>

              {layout.nodes.map((node) => {
                const module = moduleMap.get(makeFunctionKey(node.name, node.file));
                const dimmed = isDimmed(node.name, node.file);
                const headerColor = module?.color || (node.isEntry ? '#10b981' : '#f3f4f6');
                const textColor = module?.color ? '#ffffff' : node.isEntry ? '#065f46' : '#4b5563';
                const routeLabels = extractRouteLabels(node);
                const visibleAttributes = filterDisplayAttributes(node.attributes, routeLabels);
                const isRouteNode =
                  routeLabels.length > 0 || node.kind === 'http-route' || node.kind === 'controller-route';
                const visibleRouteCount = cardSize.height >= 340 ? 3 : 2;
                const showDrillButton = shouldShowDrillButton(node);
                const isNodeDrilling = drillingNodeId === node.id;

                return (
                  <div
                    key={node.id}
                    className="absolute"
                    style={{
                      left: node.x,
                      top: node.y,
                      width: cardSize.width,
                      height: cardSize.height,
                      overflow: 'visible',
                    }}
                  >
                    <div
                      className="group relative h-full border-2 rounded-2xl bg-white shadow-sm overflow-hidden flex flex-col transition-all cursor-pointer hover:shadow-md"
                      style={{
                        borderColor: dimmed ? '#d1d5db' : module?.color || (node.isEntry ? '#10b981' : '#e5e7eb'),
                        opacity: dimmed ? 0.3 : 1,
                        filter: dimmed ? 'grayscale(1)' : 'none',
                      }}
                      onClick={() => onNodeSelect?.(node)}
                      title={node.file ? `点击打开 ${node.file}${node.startLine ? `:${node.startLine}` : ''}` : node.name}
                    >
                      <div
                        className="px-3 py-2 border-b text-xs font-mono truncate flex justify-between items-center"
                        style={{
                          backgroundColor: headerColor,
                          color: textColor,
                          borderBottomColor: module?.color || (node.isEntry ? '#a7f3d0' : '#e5e7eb'),
                        }}
                      >
                        <span className="truncate" title={node.file}>
                          {node.file || '未知文件'}
                        </span>
                        {!node.isEntry && (
                          <span className="shrink-0 ml-2 flex items-center gap-1">
                            {node.drillDown !== undefined && (
                              <span
                                data-panorama-export-ignore="true"
                                className={`w-2 h-2 rounded-full ${
                                  node.stopReason === 'not_found'
                                    ? 'bg-yellow-300'
                                    : node.drillDown === 1
                                      ? 'bg-blue-200'
                                      : node.drillDown === -1
                                        ? 'bg-gray-200'
                                        : 'bg-yellow-200'
                                }`}
                              />
                            )}
                          </span>
                        )}
                      </div>

                      <div className="px-3 py-3 flex-1 flex flex-col min-w-0 overflow-hidden">
                        <div className="text-sm font-semibold text-gray-800 min-w-0 leading-snug break-words" title={node.name}>
                          {node.name}
                        </div>

                        {routeLabels.length > 0 ? (
                          <div className="mt-2 rounded-xl border border-indigo-100 bg-indigo-50/70 px-2.5 py-2">
                            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-indigo-500">URL</div>
                            <div className="mt-1 space-y-1">
                              {routeLabels.slice(0, visibleRouteCount).map((label) => (
                                <div
                                  key={`${node.id}-route-${label}`}
                                  className="text-[11px] font-medium leading-snug text-indigo-700 break-all"
                                  title={label}
                                >
                                  {label}
                                </div>
                              ))}
                              {routeLabels.length > visibleRouteCount ? (
                                <div className="text-[10px] font-medium text-indigo-500">
                                  +{routeLabels.length - visibleRouteCount} 个附加路由
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ) : null}

                        {visibleAttributes.length ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {visibleAttributes.map((attribute) => (
                              <span
                                key={`${node.id}-${attribute.label}`}
                                className={`inline-flex max-w-full truncate rounded-full border px-2 py-0.5 text-[10px] font-medium ${getAttributeClass(attribute.tone)}`}
                                title={attribute.label}
                              >
                                {attribute.label}
                              </span>
                            ))}
                          </div>
                        ) : null}

                        <div
                          className="mt-2 text-xs text-gray-500 min-w-0 leading-snug overflow-hidden"
                          style={{
                            display: '-webkit-box',
                            WebkitLineClamp: cardSize.height >= 320 ? 9 : cardSize.height >= 240 ? 7 : 4,
                            WebkitBoxOrient: 'vertical',
                          }}
                          title={node.description}
                        >
                          {node.description}
                        </div>

                        <div className="mt-auto flex items-center gap-1.5 pt-2 min-w-0 flex-wrap">
                          {node.startLine && (
                            <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">
                              L{node.startLine}
                            </span>
                          )}
                          {module && (
                            <span
                              className="truncate rounded-full px-2 py-0.5 text-[10px] font-medium"
                              style={{
                                color: module.color,
                                backgroundColor: `${module.color}18`,
                              }}
                              title={localizeModuleName(module.name)}
                            >
                              {localizeModuleName(module.name)}
                            </span>
                          )}
                          {isRouteNode && (
                            <span className="truncate rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-600">
                              路由
                            </span>
                          )}
                        </div>
                      </div>

                      <button
                        type="button"
                        data-panorama-export-ignore="true"
                        className="absolute right-2 bottom-2 h-5 w-5 rounded-md border border-gray-300 bg-white/95 text-[10px] text-gray-400 opacity-80 shadow-sm transition-opacity group-hover:opacity-100"
                        onPointerDown={handleResizeStart}
                        onClick={(event) => event.stopPropagation()}
                        title="向右下拖动调整卡片大小"
                      >
                        <span className="block rotate-45">+</span>
                      </button>
                    </div>

                    {node.hasLoadedChildren ? (
                      <button
                        type="button"
                        data-panorama-export-ignore="true"
                        className="absolute z-10 h-9 w-9 rounded-full border border-gray-300 bg-white text-sm font-semibold text-gray-600 shadow-md transition-colors hover:border-indigo-300 hover:text-indigo-600"
                        style={{ left: '50%', top: cardSize.height, transform: 'translate(-50%, -50%)' }}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleToggleNode(node.id);
                        }}
                        title={node.isCollapsed ? '展开子节点' : '收起子节点'}
                      >
                        {node.isCollapsed ? '+' : '-'}
                      </button>
                    ) : showDrillButton ? (
                      <button
                        type="button"
                        data-panorama-export-ignore="true"
                        className="absolute z-10 min-w-[72px] rounded-full border border-blue-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-blue-600 shadow-md transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-300"
                        style={{ left: '50%', top: cardSize.height, transform: 'translate(-50%, -50%)' }}
                        onClick={(event) => {
                          event.stopPropagation();
                          onNodeDrillDown?.(node);
                        }}
                        disabled={!!drillingNodeId}
                        title="继续下钻一层"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          {isNodeDrilling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span>+</span>}
                          继续下钻
                        </span>
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </TransformComponent>
        </TransformWrapper>
      </div>
    </div>
  );
}
