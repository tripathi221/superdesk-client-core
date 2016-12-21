import _ from 'lodash';
/**
 * @ngdoc directive
 * @module superdesk.apps.monitoring
 * @name sdMonitoringGroup
 *
 * @requires cards
 * @requires api
 * @requires authoringWorkspace
 * @requires $timeout
 * @requires superdesk
 * @requires session
 * @requires activityService
 * @requires workflowService
 * @requires keyboardManager
 * @requires desks
 * @requires search
 * @requires multi
 * @requires archiveService
 * @requires $rootScope
 *
 * @description
 *   A directive that generates group/section on stages of a desk or saved search.
 */
MonitoringGroup.$inject = ['cards', 'api', 'authoringWorkspace', '$timeout', 'superdesk', 'session',
    'activityService', 'workflowService', 'keyboardManager', 'desks', 'search', 'multi',
    'archiveService', '$rootScope'];
export function MonitoringGroup(cards, api, authoringWorkspace, $timeout, superdesk, session, activityService,
        workflowService, keyboardManager, desks, search, multi, archiveService, $rootScope) {
    var ITEM_HEIGHT = 57;

    return {
        templateUrl: 'scripts/apps/monitoring/views/monitoring-group.html',
        require: ['^sdMonitoringView'],
        scope: {
            group: '=',
            numItems: '=',
            viewType: '=',
            forceLimited: '@'
        },
        link: function(scope, elem, attrs, ctrls) {
            var monitoring = ctrls[0];
            var projections = search.getProjectedFields();

            scope.view = 'compact';
            scope.page = 1;
            scope.fetching = false;
            scope.previewingBroadcast = false;
            scope.loading = false;
            scope.cacheNextItems = [];
            scope.cachePreviousItems = [];
            scope.limited = !(monitoring.singleGroup || scope.group.type === 'highlights'
                || scope.group.type === 'spike');
            scope.viewColumn = monitoring.viewColumn;

            if (!_.isNil(scope.forceLimited)) {
                scope.limited = scope.forceLimited;
            }

            scope.$on('view:column', (event, data) => {
                scope.$applyAsync(() => {
                    scope.viewColumn = data.viewColumn;
                    updateGroupStyle();
                    scheduleQuery(null, {force: true});
                });
            });

            scope.style = {};

            scope.edit = edit;
            scope.select = select;
            scope.preview = preview;
            scope.renderNew = renderNew;
            scope.viewSingleGroup = viewSingleGroup;

            scope.$watchCollection('group', () => {
                if (scope.limited) {
                    updateGroupStyle();
                }

                queryItems();
            });

            scope.$on('task:stage', scheduleQuery);
            scope.$on('item:spike', scheduleIfShouldUpdate);
            scope.$on('item:copy', scheduleQuery);
            scope.$on('item:duplicate', scheduleQuery);
            scope.$on('item:translate', scheduleQuery);
            scope.$on('broadcast:created', (event, args) => {
                scope.previewingBroadcast = true;
                queryItems();
                preview(args.item);
            });
            scope.$on('item:unspike', scheduleIfShouldUpdate);
            scope.$on('$routeUpdate', (event, data) => {
                scope.scrollTop = 0;
                data.force = true;
                scope.showRefresh = false;
                scheduleQuery(event, data);
                if (scope.viewColumn) {
                    updateGroupStyle();
                }
            });
            scope.$on('broadcast:preview', (event, args) => {
                scope.previewingBroadcast = true;
                if (!_.isNil(args.item)) {
                    preview(args.item);
                } else {
                    monitoring.closePreview();
                }
            });

            scope.$on('item:highlights', scheduleQuery);
            scope.$on('item:marked_desks', scheduleQuery);
            scope.$on('content:update', scheduleIfShouldUpdate);
            scope.$on('item:unselect', () => {
                scope.selected = null;
            });

            if (scope.group.type === 'search' && search.doesSearchAgainstRepo(scope.group.search, 'ingest')) {
                scope.$on('ingest:update', (event, data) => {
                    if (!scope.showRefresh) {
                        scheduleQuery(event, data);
                    }
                });
            }

            function scheduleIfShouldUpdate(event, data) {
                if (data && data.from_stage && data.from_stage === scope.group._id) {
                    // item was moved from current stage
                    extendItem(data.item, {
                        gone: true,
                        _etag: data.from_stage // this must change to make it re-render
                    });
                    scheduleQuery(event, data);
                } else if (data && data.item && _.includes(['item:spike', 'item:unspike'], event.name)) {
                    // item was spiked/unspiked from the list
                    extendItem(data.item, {
                        gone: true,
                        _etag: data.item
                    });
                    scheduleQuery(event, data);
                } else if (data && data.to_stage && data.to_stage === scope.group._id) {
                    // new item in current stage
                    scheduleQuery(event, data);
                } else if (data && cards.shouldUpdate(scope.group, data)) {
                    scheduleQuery(event, data);
                }
            }

            function extendItem(itemId, updates) {
                scope.$apply(() => {
                    scope.items._items = scope.items._items.map((item) => {
                        if (item._id === itemId) {
                            return angular.extend(item, updates);
                        }

                        return item;
                    });

                    scope.items = angular.extend({}, scope.items); // trigger a watch
                });
            }

            scope.$on('item:fetch', scheduleIfShouldUpdate);
            scope.$on('item:move', scheduleIfShouldUpdate);

            scope.$on('$destroy', unbindActionKeyShortcuts);

            scope.$watch('selected', (newVal, oldVal) => {
                if (!newVal && scope.previewingBroadcast) {
                    scope.previewingBroadcast = false;
                }
            });

            /*
             * Change between single stage view and grouped view by keyboard
             * Keyboard shortcut: Ctrl + g
             */
            scope.$on('key:ctrl:g', () => {
                if (scope.selected) {
                    if (_.isNil(monitoring.singleGroup)) {
                        monitoring.viewSingleGroup(monitoring.selectedGroup, 'stage');
                    } else {
                        monitoring.viewMonitoringHome();
                    }
                }
            });

            // refreshes the list for matching group or view type only or if swimlane view is ON.
            scope.$on('refresh:list', (event, group) => {
                var _viewType = event.currentScope.viewType || '';

                if (group && group._id === scope.group._id ||
                        _.includes(['highlights', 'spiked'], _viewType) ||
                        !group && scope.viewColumn) {
                    scope.refreshGroup();
                }
            });

            scope.$on('render:next', (event) => {
                scope.$applyAsync(() => {
                    if (scope.items) {
                        scope.fetchNext(scope.items._items.length);
                    }
                });
            });

            /*
             * Change between single desk view and grouped view by keyboard
             * Keyboard shortcut: Ctrl + g
             */
            scope.$on('key:ctrl:alt:g', () => {
                if (scope.selected) {
                    if (_.isNil(monitoring.singleGroup)) {
                        monitoring.viewSingleGroup(monitoring.selectedGroup, 'desk');
                    } else {
                        monitoring.viewMonitoringHome();
                    }
                }
            });

            // forced refresh on refresh button click or on refresh:list
            scope.refreshGroup = function() {
                scope.$applyAsync(() => {
                    scope.scrollTop = 0;
                    monitoring.scrollTop = 0;
                });

                monitoring.showRefresh = scope.showRefresh = false;
                scheduleQuery(null, {force: true});
            };

            function updateGroupStyle() {
                if (scope.viewColumn) {
                    // maxHeight is not applicable for swimlane/column view, as each stages/column
                    // don't need to have scroll bars/ because container scroll bar of monitoring
                    // view will serve scrolling
                    scope.style.maxHeight = null;
                    $rootScope.$broadcast('resize:header');
                } else {
                    scope.style.maxHeight = (scope.group.max_items || 10) * ITEM_HEIGHT;
                }
            }
            /*
             * Bind item actions on keyboard shortcuts
             * Keyboard shortcuts are defined with actions
             *
             * @param {Object} item
             */
            function bindActionKeyShortcuts(item) {
                // First unbind all binded shortcuts
                if (monitoring.bindedItems.length) {
                    unbindActionKeyShortcuts();
                }

                var intent = {action: 'list'};

                superdesk.findActivities(intent, item).forEach((activity) => {
                    if (activity.keyboardShortcut && workflowService.isActionAllowed(item, activity.action)) {
                        monitoring.bindedItems.push(
                            scope.$on('key:' + activity.keyboardShortcut.replace('+', ':'),
                            () => {
                                if (activity._id === 'mark.item') {
                                    bindMarkItemShortcut();
                                } else {
                                    activityService.start(activity, {data: {item: scope.selected}});
                                }
                            })
                        );
                    }
                });
            }

            /*
             * Bind highlight dropdown action
             * Keyboard shortcut is defined with action
             *
             * @param {Object} item
             */
            function bindMarkItemShortcut() {
                elem.find('.active .more-activity-toggle').click();
                var highlightDropdown = angular.element('.more-activity-menu.open .dropdown--noarrow');

                highlightDropdown.addClass('open');
                if (highlightDropdown.find('button').length > 0) {
                    highlightDropdown.find('button:not([disabled])')[0].focus();

                    keyboardManager.push('up', () => {
                        highlightDropdown.find('button:focus')
                            .parent('li')
                            .prev()
                            .children('button')
                            .focus();
                    });
                    keyboardManager.push('down', () => {
                        highlightDropdown.find('button:focus')
                            .parent('li')
                            .next()
                            .children('button')
                            .focus();
                    });
                }
            }

            /*
             * Unbind all item actions
             */
            function unbindActionKeyShortcuts() {
                monitoring.bindedItems.forEach((func) => {
                    func();
                });
                monitoring.bindedItems = [];
            }

            var queryTimeout;

            /**
             * Schedule content reload after some delay
             */
            function scheduleQuery(event, data) {
                if (!queryTimeout) {
                    queryTimeout = $timeout(() => {
                        queryItems(event, data);
                        scope.$applyAsync(() => {
                            // ignore any updates requested in current $digest
                            queryTimeout = null;
                        });
                    }, 1000, false);
                }
            }

            var criteria;

            function edit(item) {
                if (item.state !== 'spiked') {
                    if (item._type === 'ingest') {
                        var intent = {action: 'list', type: 'ingest'},
                            activity = superdesk.findActivities(intent, item)[0];

                        activityService.start(activity, {data: {item: item}})
                            .then((item) => {
                                authoringWorkspace.edit(item);
                            });
                    } else if (item.type === 'composite' && item.package_type === 'takes') {
                        authoringWorkspace.view(item);
                    } else if (archiveService.isPublished(item)) {
                        authoringWorkspace.view(item);
                    } else {
                        authoringWorkspace.edit(item);
                    }
                }
            }

            function select(item) {
                scope.currentGroup = item.task ? item.task.stage : null;
                scope.selected = item;
                monitoring.selectedGroup = scope.group;
                monitoring.preview(item);
                bindActionKeyShortcuts(item);
            }

            function preview(item) {
                if (item) {
                    // for items from external source or if type is undefined.
                    if (item._type === 'externalsource') {
                        select(item);
                        return;
                    }

                    scope.loading = true;
                    criteria = cards.criteria(scope.group, null, monitoring.queryParam);
                    let previewCriteria = search.getSingleItemCriteria(item, criteria);

                    apiquery(previewCriteria, false).then((completeItems) => {
                        let completeItem = search.mergeHighlightFields(completeItems._items[0]);

                        select(completeItem);
                    })
                    .finally(() => {
                        scope.loading = false;
                    });
                } else {
                    select(item);
                }

                if (scope.viewColumn) {
                    updateGroupStyle();
                }
            }

            // For highlight page return only highlights items, i.e, include only last version if item type is published
            function getOnlyHighlightsItems(items) {
                items._items = _.filter(items._items, (item) =>
                    item._type === 'published' && item.last_published_version || item._type !== 'published');
                return items;
            }

            // Determine if item is previewing for its respective view type.
            function isItemPreviewing() {
                if (scope.group.type === 'spike') {
                    return monitoring.previewItem &&
                        monitoring.previewItem.task.desk === scope.group._id;
                } else if (scope.group.type === 'highlights') {
                    return monitoring.previewItem &&
                        _.includes(monitoring.previewItem.highlights, monitoring.queryParam.highlight);
                }

                return monitoring.previewItem && monitoring.previewItem.task.stage === scope.group._id;
            }

            function queryItems(event, data) {
                criteria = cards.criteria(scope.group, null, monitoring.queryParam);
                criteria.source.from = 0;
                criteria.source.size = 25;
                var originalQuery;

                // when forced refresh or query then keep query size default as set 25 above.
                // To compare current scope of items, consider fetching same number of items.
                if (!(data && data.force) && scope.items && scope.items._items.length > 25) {
                    criteria.source.size = scope.items._items.length;
                }

                if (desks.changeDesk) {
                    desks.changeDesk = false;
                    monitoring.singleGroup = null;
                    multi.reset();
                }

                if (data && (data.item || data.items || data.item_id) && scope.showRefresh && !data.force) {
                    // if we know the ids of the items then try to fetch those only
                    originalQuery = angular.extend({}, criteria.source.query);

                    let items = data.items || {};

                    if (data.item || data.item_id) {
                        items[data.item || data.item_id] = 1;
                    }

                    criteria.source.query = search.getItemQuery(items);
                }

                return apiquery(criteria, true).then((items) => {
                    if (!scope.showRefresh && data && !data.force && data.user !== session.identity._id) {
                        var itemPreviewing = isItemPreviewing();
                        var _data = {
                            newItems: items,
                            scopeItems: scope.items,
                            scrollTop: scope.viewColumn ? monitoring.scrollTop : scope.scrollTop,
                            isItemPreviewing: itemPreviewing
                        };

                        monitoring.showRefresh = scope.showRefresh = search.canShowRefresh(_data);
                    }

                    if (!scope.showRefresh || data && data.force) {
                        scope.total = items._meta.total;
                        let onlyHighlighted = scope.group.type === 'highlights' ? getOnlyHighlightsItems(items) : items;

                        monitoring.totalItems = onlyHighlighted._meta.total;
                        scope.items = search.mergeItems(onlyHighlighted, scope.items, null, true);
                    } else {
                        // update scope items only with the matching fetched items
                        scope.items = search.updateItems(items, scope.items);
                    }
                })
               .finally(() => {
                   if (originalQuery) {
                       criteria.source.query = originalQuery;
                   }
               });
            }

            function render(next) {
                return apiquery(criteria, true).then((items) => {
                    scope.$applyAsync(() => {
                        if (scope.total !== items._meta.total) {
                            scope.total = items._meta.total;
                        }
                        let onlyHighlighted = scope.group.type === 'highlights' ? getOnlyHighlightsItems(items) : items;

                        scope.items = search.mergeItems(onlyHighlighted, scope.items, next);
                    });
                });
            }

            scope.fetchNext = function(from) {
                criteria.source.from = from;
                render(true);
            };

            /**
             * Request the data on search or archive endpoints
             * return {promise} list of items
             */
            function apiquery(searchCriteria, applyProjections) {
                var provider = 'search';

                if (scope.group.type === 'search' || desks.isPublishType(scope.group.type)) {
                    if (searchCriteria.repo && searchCriteria.repo.indexOf(',') === -1) {
                        provider = searchCriteria.repo;
                        if (!angular.isDefined(searchCriteria.source.size)) {
                            searchCriteria.source.size = 25;
                        }
                    }
                } else {
                    provider = 'archive';
                }

                if (applyProjections) {
                    searchCriteria.projections = JSON.stringify(projections);
                }

                return api.query(provider, searchCriteria);
            }

            function renderNew() {
                scope.total += scope.newItemsCount;
                scope.newItemsCount = 0;
                render();
            }

            function viewSingleGroup(group, type) {
                monitoring.viewSingleGroup(group, type);
            }
        }
    };
}
