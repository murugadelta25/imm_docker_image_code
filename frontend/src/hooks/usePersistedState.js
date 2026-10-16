import { useState, useEffect, useRef, useCallback } from 'react';
import { loadDraft, saveDraft, clearDraft } from '../utils/formPersistence';

/**
 * useState synced to sessionStorage — survives F5 / refresh in the same tab.
 */
export function usePersistedState(key, initialValue, options = {}) {
  const { debounceMs = 350 } = options;

  const [state, setState] = useState(() => {
    if (!key) return typeof initialValue === 'function' ? initialValue() : initialValue;
    const saved = loadDraft(key);
    if (saved != null) return saved;
    return typeof initialValue === 'function' ? initialValue() : initialValue;
  });

  const persistRef = useRef(true);

  useEffect(() => {
    if (!key || !persistRef.current) return undefined;
    const timer = setTimeout(() => {
      saveDraft(key, state);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [key, state, debounceMs]);

  const clearPersisted = useCallback(() => {
    if (key) clearDraft(key);
  }, [key]);

  const resetPersisted = useCallback((nextValue) => {
    persistRef.current = false;
    if (key) clearDraft(key);
    setState(nextValue);
    requestAnimationFrame(() => {
      persistRef.current = true;
    });
  }, [key]);

  return [state, setState, { clearPersisted, resetPersisted }];
}

export default usePersistedState;
