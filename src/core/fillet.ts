/// <reference path="intersect.ts" />

module MakerJs.path {

    /**
     * @private
     */
    interface IPointProperty {
        point: IPoint;
        propertyName: string;
    }

    /**
     * @private
     */
    interface IMatchPointProperty extends IPointProperty {
        path: IPath;
        isStart: boolean;
        shardPoint?: IPoint;
    }

    /**
     * @private
     */
    interface IFilletResult {
        filletAngle: number;
        clipPath: () => void;
    }

    /**
     * @private
     */
    function getPointProperties(pathToInspect: IPath): IPointProperty[]{

        var result: IPointProperty[] = null;

        var map: IPathFunctionMap = {};

        map[pathType.Arc] = function (arc: IPathArc) {
            var arcPoints = point.fromArc(arc);
            result = [
                { point: arcPoints[0], propertyName: 'startAngle' },
                { point: arcPoints[1], propertyName: 'endAngle' }
            ];
        };

        map[pathType.Line] = function (line: IPathLine) {
            result = [
                { point: line.origin, propertyName: 'origin' },
                { point: line.end, propertyName: 'end' }
            ];
        }

        var fn = map[pathToInspect.type];
        if (fn) {
            fn(pathToInspect);
        }

        return result;
    }

    /**
     * @private
     */
    function getMatchingPointProperties(path1: IPath, path2: IPath): IMatchPointProperty[] {
        var path1Properties = getPointProperties(path1);
        var path2Properties = getPointProperties(path2);

        var result: IMatchPointProperty[] = null;

        function makeMatch(pathContext: IPath, pointProperties: IPointProperty[], index: number): IMatchPointProperty {
            return {
                path: pathContext,
                isStart: index == 0,
                propertyName: pointProperties[index].propertyName,
                point: pointProperties[index].point
            };
        }

        function check(i1: number, i2: number) {
            if (point.areEqualRounded(path1Properties[i1].point, path2Properties[i2].point)) {
                result = [
                    makeMatch(path1, path1Properties, i1),
                    makeMatch(path2, path2Properties, i2)
                ];
                return true;
            }
            return false;
        }

        check(0, 0) || check(0, 1) || check(1, 0) || check(1, 1);

        return result;
    }

    /**
     * @private
     */
    function cloneAndBreakPath(pathToShard: IPath, shardPoint: IPoint): IPath[] {
        var shardStart = cloneObject<IPath>(pathToShard);
        var shardEnd = breakAtPoint(shardStart, shardPoint);
        return [shardStart, shardEnd];
    }

    /**
     * @private
     */
    function getGuidePath(context: IMatchPointProperty, filletRadius: number, nearPoint: IPoint): IPath {
        var result: IPath = null;

        var map: IPathFunctionMap = {};

        map[pathType.Arc] = function (arc: IPathArc) {
            var guideRadius = arc.radius;

            //see if the guideline should be external or internal to the context arc.
            var guideArcShard = <IPathArc>cloneAndBreakPath(arc, context.shardPoint)[context.isStart ? 0 : 1];
            if (guideArcShard) {
                if (measure.isArcConcaveTowardsPoint(guideArcShard, nearPoint)) {
                    guideRadius -= filletRadius;
                } else {
                    guideRadius += filletRadius;
                }

                result = new paths.Arc(arc.origin, guideRadius, arc.startAngle, arc.endAngle);
            }
        };

        map[pathType.Line] = function (line: IPathLine) {
            result = new paths.Parallel(line, filletRadius, nearPoint);
        }

        var fn = map[context.path.type];
        if (fn) {
            fn(context.path);
        }

        return result;
    }

    /**
     * @private
     */
    function getFilletResult(context: IMatchPointProperty, filletRadius: number, filletCenter: IPoint): IFilletResult {
        var result: IFilletResult = null;

        var map: IPathFunctionMap = {};

        map[pathType.Arc] = function (arc: IPathArc) {
            var guideLine = new paths.Line(arc.origin, filletCenter);
            var guideLineAngle = angle.ofLineInDegrees(guideLine);
            var filletAngle = guideLineAngle;

            //the context is an arc and the fillet is an arc so they will be tangent. If the fillet is external to the arc then the tangent is opposite.
            if (!measure.isArcConcaveTowardsPoint(arc, filletCenter)) {
                filletAngle += 180;
            }

            result = {
                filletAngle: filletAngle,
                clipPath: function () {
                    arc[context.propertyName] = guideLineAngle;
                }
            };
        };

        map[pathType.Line] = function (line: IPathLine) {
            //make a small vertical line
            var guideLine = new paths.Line([0, 0], [0, 1]);

            //rotate this vertical line the same angle as the line context. It will be perpendicular.
            var lineAngle = angle.ofLineInDegrees(line);
            path.rotate(guideLine, lineAngle, [0, 0]);
            path.moveRelative(guideLine, filletCenter);

            //get the intersection point of the slopes of the context line and the perpendicular line. This is where the fillet meets the line.
            var intersectionPoint = slopeIntersectionPoint(line, guideLine);
            if (intersectionPoint) {
                result = {
                    filletAngle: angle.toDegrees(angle.ofPointInRadians(filletCenter, intersectionPoint)),
                    clipPath: function () {
                        line[context.propertyName] = intersectionPoint;
                    }
                };
            }
        }

        var fn = map[context.path.type];
        if (fn) {
            fn(context.path);
        }

        if (result) {

            //temporarily clip the path.
            var originalValue = context.path[context.propertyName];
            result.clipPath();

            //don't allow a fillet which effectivly eliminates the path.
            if (measure.pathLength(context.path) == 0) {
                result = null;
            }

            //revert the clipping we just did.
            context.path[context.propertyName] = originalValue;
        }

        return result;
    }

    /**
     * Adds a round corner to the inside angle between 2 paths. The paths must meet at one point.
     *
     * @param path1 First path to fillet, which will be modified to fit the fillet.
     * @param path2 Second path to fillet, which will be modified to fit the fillet.
     * @returns Arc path object of the new fillet.
     */
    export function fillet(path1: IPath, path2: IPath, filletRadius: number): IPath {

        if (path1 && path2 && filletRadius && filletRadius > 0) {

            //first find the common point
            var commonProperty = getMatchingPointProperties(path1, path2);
            if (commonProperty) {

                //since arcs can curl beyond, we need a local reference point. 
                //An intersection with a circle of the same radius as the desired fillet should suffice.
                var shardCircle = new paths.Circle(commonProperty[0].point, filletRadius);

                //get shard circle intersection points
                for (var i = 0; i < 2; i++) {
                    var shardCircleIntersection = intersection(shardCircle, commonProperty[i].path);
                    if (!shardCircleIntersection) {
                        return null;
                    }
                    commonProperty[i].shardPoint = shardCircleIntersection.intersectionPoints[0];
                }

                //get "parallel" guidelines
                var guidePaths: IPath[] = [];
                for (var i = 0; i < 2; i++) {
                    var otherPathShardPoint = commonProperty[1 - i].shardPoint;
                    var guidePath = getGuidePath(commonProperty[i], filletRadius, otherPathShardPoint);
                    guidePaths.push(guidePath);
                }

                //the center of the fillet is the point where the guidelines intersect.
                var intersectionPoint = intersection(guidePaths[0], guidePaths[1]);
                if (intersectionPoint) {

                    var center: IPoint;

                    //if guidelines intersect in more than one place, choose the closest one.
                    if (intersectionPoint.intersectionPoints.length == 1) {
                        center = intersectionPoint.intersectionPoints[0];
                    } else {
                        center = point.closest(commonProperty[0].point, intersectionPoint.intersectionPoints);
                    }

                    //get the angles of the fillet and a function which clips the path to the fillet.
                    var results: IFilletResult[] = [];
                    for (var i = 0; i < 2; i++) {
                        var result = getFilletResult(commonProperty[i], filletRadius, center)
                        if (!result) {
                            return null;
                        }
                        results.push(result);
                    }

                    var filletArc = new paths.Arc(center, filletRadius, results[0].filletAngle, results[1].filletAngle);
                    var filletSpan = measure.arcAngle(filletArc);

                    //the algorithm is only valid for fillet less than 180 degrees
                    if (filletSpan == 180) {
                        return null;
                    }

                    if (filletSpan > 180) {
                        //swap to make smallest angle
                        filletArc.startAngle = results[1].filletAngle;
                        filletArc.endAngle = results[0].filletAngle;
                    }

                    //clip the paths and return the fillet arc.
                    results[0].clipPath();
                    results[1].clipPath();

                    return filletArc;
                }
            }
        }
        return null;
    }
}
