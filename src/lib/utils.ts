export function truncateJson(obj: any): any {
  if (typeof obj === 'string') {
    if (obj.length > 500) {
      const truncated = obj.substring(0, 500);
      const remaining = obj.substring(500);
      // Calculate approximate byte size for the remaining string
      const remainingBytes = new Blob([remaining]).size;
      return `${truncated}··· (后续还有 ${remainingBytes} 字节)`;
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(truncateJson);
  }
  if (obj !== null && typeof obj === 'object') {
    const newObj: any = {};
    for (const key in obj) {
      newObj[key] = truncateJson(obj[key]);
    }
    return newObj;
  }
  return obj;
}
