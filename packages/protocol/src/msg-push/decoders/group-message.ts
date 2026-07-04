import type { GroupMessage } from '../../events';
import type { MsgPushDecoder } from '../registry';
import { decodeRichBody } from '../rich-body-decoder';

export const decodeGroupMessage: MsgPushDecoder = (ctx) => {
  const ev: GroupMessage = {
    kind: 'group_message',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    senderUin: ctx.fromUin,
    msgSeq: ctx.head.sequence,
    msgId: ctx.head.msgId & 0x7FFFFFFF,
    elements: decodeRichBody(ctx.body, true),
    groupId: 0,
    senderNick: '',
    senderCard: '',
    senderRole: '',
  };
  const grp = ctx.responseHead?.grp;
  if (grp) {
    ev.groupId = grp.groupUin ?? 0;
    // Sender name priority (#201): the group-history fetch fills `memberName`
    // (field 2); the local member cache gives a clean nickname/card split; and
    // live pushes + merged-forward nodes carry the display name in `memberCard`
    // (field 4). Prefer the explicit field-2 name, then the cache, then field 4
    // — the last is what lets a forward node from a group the bot isn't in keep
    // its per-node sender name without a member-list lookup.
    ev.senderNick = grp.memberName ?? '';
  }
  const member = ctx.identity.findGroupMember(ev.groupId, ctx.fromUin);
  if (member) {
    if (!ev.senderNick) ev.senderNick = member.nickname;
    ev.senderCard = member.card;
    ev.senderRole = member.role;
  } else if (!ev.senderNick && grp?.memberCard) {
    ev.senderNick = grp.memberCard;
  }
  return [ev];
};
