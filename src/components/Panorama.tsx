import React, { useMemo } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { SubFunctionAnalysisResult, SubFunction } from '../lib/ai';

interface PanoramaProps {
  data: SubFunctionAnalysisResult | null;
  entryFile: string;
}

const CARD_WIDTH = 220;
const CARD_HEIGHT = 80;
const VERTICAL_SPACING = 60;
const HORIZONTAL_SPACING = 40;

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  name: string;
  file: string;
  description: string;
  isEntry: boolean;
  drillDown?: number;
  stopReason?: string;
}

function buildTreeLayout(
  data: SubFunctionAnalysisResult,
  entryFile: string
): { nodes: LayoutNode[]; edges: Array<{ id: string; x1: number; y1: number; x2: number; y2: number }> } {
  const nodes: LayoutNode[] = [];
  const edges: Array<{ id: string; x1: number; y1: number; x2: number; y2: number }> = [];
  let currentX = 20;
  let currentY = 20;

  nodes.push({
    id: 'entry',
    x: currentX,
    y: currentY,
    name: data.entryFunctionName === 'Analyzing...' ? '正在分析入口函数...' : data.entryFunctionName,
    file: entryFile,
    description: data.entryFunctionName === 'Analyzing...' ? '请稍候，AI 正在提取子函数' : '主入口函数',
    isEntry: true,
  });

  const entryCenterX = currentX + CARD_WIDTH / 2;
  const entryBottomY = currentY + CARD_HEIGHT;
  currentX += CARD_WIDTH + HORIZONTAL_SPACING;

  const cursor = { x: currentX, y: 20 };

  function addSubNodes(
    subs: SubFunction[],
    parentCenterX: number,
    parentBottomY: number,
    prefix: string
  ): void {
    subs.forEach((sub, index) => {
      const id = `${prefix}-${index}`;
      nodes.push({
        id,
        x: cursor.x,
        y: cursor.y,
        name: sub.name,
        file: sub.file,
        description: sub.description,
        isEntry: false,
        drillDown: sub.drillDown,
        stopReason: sub.stopReason,
      });
      edges.push({
        id: `edge-${id}`,
        x1: parentCenterX,
        y1: parentBottomY,
        x2: cursor.x,
        y2: cursor.y + CARD_HEIGHT / 2,
      });
      const nodeCenterX = cursor.x + CARD_WIDTH / 2;
      const nodeBottomY = cursor.y + CARD_HEIGHT;
      cursor.y += CARD_HEIGHT + VERTICAL_SPACING;
      if (sub.children && sub.children.length > 0) {
        const saveX = cursor.x;
        cursor.x += CARD_WIDTH + HORIZONTAL_SPACING;
        addSubNodes(sub.children, nodeCenterX, nodeBottomY, id);
        cursor.x = saveX;
      }
    });
  }

  addSubNodes(data.subFunctions, entryCenterX, entryBottomY, 'sub');
  const maxY = nodes.length ? Math.max(...nodes.map(n => n.y + CARD_HEIGHT)) : 0;
  const layoutHeight = Math.max(1000, maxY + 40);
  const layoutWidth = Math.max(2000, (cursor.x + CARD_WIDTH) + 40);
  return { nodes, edges, layoutWidth, layoutHeight };
}

export default function Panorama({ data, entryFile }: PanoramaProps) {
  if (!data) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-sm bg-gray-50/50">
        等待函数分析...
      </div>
    );
  }

  const { nodes, edges, layoutWidth, layoutHeight } = useMemo(() => buildTreeLayout(data, entryFile), [data, entryFile]);

  return (
    <div className="h-full w-full bg-gray-50/50 overflow-hidden relative flex flex-col">
      <div className="shrink-0 px-2 py-1.5 flex items-center gap-4 text-[10px] text-gray-500 border-b border-gray-100 bg-white/80">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /> 需要下钻（已尝试，有子节点或已因未找到/系统/深度停止）</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-yellow-400" /> 不确定是否下钻（仍会尝试下钻，故可能有子节点）或 未找到定义</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-300" /> 无需下钻</span>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
      <TransformWrapper
        initialScale={1}
        minScale={0.1}
        maxScale={4}
        centerOnInit={false}
        wheel={{ step: 0.1 }}
      >
        <TransformComponent wrapperStyle={{ width: '100%', height: '100%' }}>
          <div className="relative" style={{ width: layoutWidth, height: layoutHeight }}>
            {/* Edges */}
            <svg className="absolute top-0 left-0 w-full h-full pointer-events-none">
              {edges.map(edge => {
                // Draw a dashed line with a right angle (orthogonal routing)
                const path = `M ${edge.x1} ${edge.y1} V ${edge.y2} H ${edge.x2}`;
                return (
                  <path
                    key={edge.id}
                    d={path}
                    fill="none"
                    stroke="#9ca3af"
                    strokeWidth="2"
                    strokeDasharray="5,5"
                  />
                );
              })}
            </svg>

            {/* Nodes */}
            {nodes.map(node => (
              <div
                key={node.id}
                className={`absolute border-2 rounded-xl bg-white shadow-sm overflow-hidden flex flex-col`}
                style={{
                  left: node.x,
                  top: node.y,
                  width: CARD_WIDTH,
                  height: CARD_HEIGHT,
                  borderColor: node.isEntry ? '#10b981' : '#e5e7eb', // emerald-500 for entry
                }}
              >
                <div className={`px-3 py-1.5 border-b text-xs font-mono truncate flex justify-between items-center ${node.isEntry ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-gray-50 text-gray-600 border-gray-100'}`}>
                  <span className="truncate" title={node.file}>{node.file}</span>
                  {!node.isEntry && (
                    <>
                      {node.drillDown !== undefined && (
                        <span
                          className={`shrink-0 ml-2 w-2 h-2 rounded-full ${
                            node.stopReason === 'not_found'
                              ? 'bg-yellow-400'
                              : node.drillDown === 1
                              ? 'bg-blue-500'
                              : node.drillDown === -1
                              ? 'bg-gray-300'
                              : 'bg-yellow-400'
                          }`}
                          title={
                            node.stopReason === 'not_found'
                              ? '未找到定义（下钻时无法定位该函数）'
                              : node.drillDown === 1
                              ? '需要下钻：已尝试下钻，有子节点或已因未找到/系统函数/深度限制停止'
                              : node.drillDown === -1
                              ? '无需下钻'
                              : '不确定是否下钻：仍会尝试下钻，故可能有子节点'
                          }
                        />
                      )}
                      {node.stopReason && (
                        <span className="shrink-0 ml-1 text-[10px] text-gray-400" title={`停止原因: ${node.stopReason === 'max_depth' ? '达到最大深度' : node.stopReason === 'not_found' ? '未找到定义' : node.stopReason === 'system_function' ? '系统/库函数' : node.stopReason === 'non_core' ? '非核心函数' : node.stopReason}`}>
                          [{node.stopReason === 'max_depth' ? '深度' : node.stopReason === 'not_found' ? '未找到' : node.stopReason === 'system_function' ? '系统' : node.stopReason === 'non_core' ? '非核心' : ''}]
                        </span>
                      )}
                    </>
                  )}
                </div>
                <div className="px-3 py-2 flex-1 flex flex-col justify-center">
                  <div className="text-sm font-semibold text-gray-800 truncate flex items-center" title={node.name}>
                    {node.name === '正在分析入口函数...' && (
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-emerald-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    )}
                    {node.name}
                  </div>
                  <div className="text-xs text-gray-500 truncate mt-0.5" title={node.description}>
                    {node.description}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </TransformComponent>
      </TransformWrapper>
      </div>
    </div>
  );
}
