"use client";

import { Eye, EyeClosed, Star } from "iconoir-react";
import { Star as StarSolid } from "iconoir-react/solid";
import { useSetting } from "@/lib/client/settings";
import { parseModelList, toggleModel } from "@/lib/model-prefs";

const MARK =
  "tap relative grid size-7 shrink-0 place-items-center rounded-[6px] text-ink-3 transition-opacity duration-100 hover:bg-hover hover:text-ink focus-visible:opacity-100 sm:size-6";

/** Star and hide buttons beside a model in the picker (Settings > Agents > Models). Shown on hover or focus, and
 * always on touch screens; a starred model keeps its star. */
export function ModelMarks({ id, name }: { id: string; name: string }) {
  const [favorites, setFavorites] = useSetting("favoriteModels");
  const [hidden, setHidden] = useSetting("hiddenModels");
  const starred = parseModelList(favorites).includes(id);
  const isHidden = parseModelList(hidden).includes(id);
  const idle = "opacity-0 group-hover/model:opacity-100 group-focus-within/model:opacity-100 pointer-coarse:opacity-100";
  return (
    <span className="flex shrink-0 items-center gap-0.5 pr-1">
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={isHidden}
        aria-label={isHidden ? `Show ${name}` : `Hide ${name}`}
        title={isHidden ? "Show in the list" : "Hide from the list"}
        onClick={() => setHidden(toggleModel(hidden, id))}
        className={`${MARK} ${idle}`}
      >
        {isHidden ? <Eye width={14} height={14} strokeWidth={1.8} aria-hidden /> : <EyeClosed width={14} height={14} strokeWidth={1.8} aria-hidden />}
      </button>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={starred}
        aria-label={`Favorite ${name}`}
        title={starred ? "Remove from favorites" : "Add to favorites"}
        onClick={() => setFavorites(toggleModel(favorites, id))}
        className={`${MARK} ${starred ? "text-orange hover:text-orange" : idle}`}
      >
        {starred ? <StarSolid width={14} height={14} aria-hidden /> : <Star width={14} height={14} strokeWidth={1.8} aria-hidden />}
      </button>
    </span>
  );
}
