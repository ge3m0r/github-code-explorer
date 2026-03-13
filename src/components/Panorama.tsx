import React, { useMemo } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { SubFunctionAnalysisResult } from '../lib/ai';

interface PanoramaProps {
  data: SubFunctionAnalysisResult | null;
  entryFile: string;
}

const CARD_WIDTH = 220;
const CARD_HEIGHT = 80;
const VERTICAL_SPACING = 60;
const HORIZONTAL_SPACING = 40;

export default function Panorama({ data, entryFile }: PanoramaProps) {
  if (!data) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-sm bg-gray-50/50">
        等待函数分析...
      </div>
    );
  }

  // Simple layout: Entry function at top left, sub-functions in a column below and to the right
  const nodes = [];
  const edges = [];

  // Entry node
  nodes.push({
    id: 'entry',
    x: 20,
    y: 20,
    name: data.entryFunctionName === 'Analyzing...' ? '正在分析入口函数...' : data.entryFunctionName,
    file: entryFile,
    description: data.entryFunctionName === 'Analyzing...' ? '请稍候，AI 正在提取子函数' : '主入口函数',
    isEntry: true,
  });

  // Sub-function nodes
  data.subFunctions.forEach((sub, index) => {
    const x = 20 + CARD_WIDTH / 2 + HORIZONTAL_SPACING;
    const y = 20 + CARD_HEIGHT + VERTICAL_SPACING + index * (CARD_HEIGHT + VERTICAL_SPACING);
    
    nodes.push({
      id: `sub-${index}`,
      x,
      y,
      name: sub.name,
      file: sub.file,
      description: sub.description,
      isEntry: false,
      drillDown: sub.drillDown,
    });

    // Edge from entry to sub
    edges.push({
      id: `edge-${index}`,
      x1: 20 + CARD_WIDTH / 2,
      y1: 20 + CARD_HEIGHT,
      x2: x,
      y2: y + CARD_HEIGHT / 2,
    });
  });

  return (
    <div className="h-full w-full bg-gray-50/50 overflow-hidden relative">
      <TransformWrapper
        initialScale={1}
        minScale={0.1}
        maxScale={4}
        centerOnInit={false}
        wheel={{ step: 0.1 }}
      >
        <TransformComponent wrapperStyle={{ width: '100%', height: '100%' }}>
          <div className="relative" style={{ width: 2000, height: Math.max(1000, nodes.length * 150) }}>
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
                  <span className="truncate">{node.file}</span>
                  {!node.isEntry && node.drillDown !== undefined && (
                    <span className={`shrink-0 ml-2 w-2 h-2 rounded-full ${node.drillDown === 1 ? 'bg-blue-500' : node.drillDown === -1 ? 'bg-gray-300' : 'bg-yellow-400'}`} title={node.drillDown === 1 ? '需要下钻分析' : node.drillDown === -1 ? '无需下钻' : '不确定是否需要下钻'} />
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
  );
}
