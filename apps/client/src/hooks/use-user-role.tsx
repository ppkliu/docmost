import { useAtom } from "jotai";
import { UserRole } from "@/lib/types.ts";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import { isSpaceMemberCreateEnabled } from "@/lib/config.ts";

export const useUserRole = () => {
  const [currentUser] = useAtom(currentUserAtom);

  const isAdmin =
    currentUser?.user?.role === UserRole.ADMIN ||
    currentUser?.user?.role === UserRole.OWNER;

  const isOwner = currentUser?.user?.role === UserRole.OWNER;

  const isMember = currentUser?.user?.role === UserRole.MEMBER;

  // Mirrors the server's `Create / Space` ability: admins always, members only
  // when the deployment enabled it.
  const canCreateSpace = isAdmin || (isMember && isSpaceMemberCreateEnabled());

  return { isAdmin, isOwner, isMember, canCreateSpace };
};

export default useUserRole;
