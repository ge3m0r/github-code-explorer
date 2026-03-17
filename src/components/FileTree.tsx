import { useState } from 'react';
import { FileNode } from '../lib/github';
import { ChevronRight, ChevronDown, File, Folder } from 'lucide-react';
import { clsx } from 'clsx';

interface FileTreeProps {
  nodes: FileNode[];
  onSelect: (node: FileNode) => void;
  selectedPath?: string;
  entryPath?: string;
}

export default function FileTree({ nodes, onSelect, selectedPath, entryPath }: FileTreeProps) {
  return (
    <div className="text-sm font-mono">
      {nodes.map(node => (
        <TreeNode 
          key={node.path} 
          node={node} 
          onSelect={onSelect} 
          selectedPath={selectedPath} 
          entryPath={entryPath}
        />
      ))}
    </div>
  );
}

function TreeNode({ node, onSelect, selectedPath, entryPath, depth = 0 }: { node: FileNode, onSelect: (node: FileNode) => void, selectedPath?: string, entryPath?: string, depth?: number }) {
  const [isOpen, setIsOpen] = useState(false);
  const isSelected = selectedPath === node.path;
  const isDir = node.type === 'tree';
  const isEntry = entryPath === node.path;

  const handleClick = () => {
    if (isDir) {
      setIsOpen(!isOpen);
    } else {
      onSelect(node);
    }
  };

  return (
    <div>
      <div 
        className={clsx(
          "flex items-center py-1.5 px-2 cursor-pointer rounded-md transition-colors",
          isSelected ? "bg-gray-200 text-gray-900" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleClick}
      >
        <div className="w-4 h-4 mr-1.5 flex items-center justify-center shrink-0">
          {isDir ? (
            isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />
          ) : (
            <File className="w-3.5 h-3.5 opacity-70" />
          )}
        </div>
        {isDir && <Folder className="w-3.5 h-3.5 mr-1.5 text-gray-400 shrink-0" />}
        <span className="truncate">{node.name}</span>
        {isEntry && (
          <span className="ml-2 shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
            ENTRY
          </span>
        )}
      </div>
      {isDir && isOpen && node.children && (
        <div>
          {node.children.map(child => (
            <TreeNode 
              key={child.path} 
              node={child} 
              onSelect={onSelect} 
              selectedPath={selectedPath} 
              entryPath={entryPath}
              depth={depth + 1} 
            />
          ))}
        </div>
      )}
    </div>
  );
}
