// Cross-view navigation. Lets any deeply-nested component (e.g. a wikilink
// rendered inside react-markdown, or a skill-name button in Commands)
// request a view switch + selection without prop-drilling callbacks.

import { createContext, useContext } from 'react';

// View id can be any string — was originally a closed enum but became open
// once apps moved to manifest-based discovery (src/apps/<id>/manifest.ts).
// Known legacy views are listed in App.tsx; new apps add via the apps/ folder.
export type ViewId = string;

export interface NavigationApi {
  view: ViewId;
  setView: (v: ViewId) => void;

  // Target wiki entry id to select in Vault view on next mount/update.
  targetEntryId: string | null;
  navigateToEntry: (id: string) => void;
  clearTargetEntry: () => void;

  // Target skill name to select in Skills view on next mount/update.
  targetSkillName: string | null;
  navigateToSkill: (name: string) => void;
  clearTargetSkill: () => void;
}

export const NavigationContext = createContext<NavigationApi | null>(null);

export function useNavigation(): NavigationApi {
  const ctx = useContext(NavigationContext);
  if (!ctx) {
    throw new Error('useNavigation must be called inside <NavigationContext.Provider>');
  }
  return ctx;
}
