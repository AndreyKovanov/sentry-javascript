import { record } from 'rrweb';

import { htmlTreeAsString } from '@sentry/utils';

export function handleDom(handlerData: any) {
  // Taken from https://github.com/getsentry/sentry-javascript/blob/master/packages/browser/src/integrations/breadcrumbs.ts#L112
  let target;
  let targetNode;

  // Accessing event.target can throw (see getsentry/raven-js#838, #768)
  try {
    targetNode =
      (handlerData.event.target as Node) ||
      (handlerData.event as unknown as Node);
    target = htmlTreeAsString(targetNode);
  } catch (e) {
    target = '<unknown>';
  }

  if (target.length === 0) {
    return null;
  }

  return {
    timestamp: new Date().getTime() / 1000,
    type: 'default',
    category: `ui.${handlerData.name}`,
    message: target,
    data: {
      // Not sure why this errors, Node should be correct (Argument of type 'Node' is not assignable to parameter of type 'INode')
      nodeId: targetNode ? record.mirror.getId(targetNode as any) : undefined,
    },
  };
}
