import generate from "@babel/generator";
import { GeneratorComponents } from "./types";
import * as t from "@babel/types";
import { Replacer } from "./replace/replacer";
import { ParseResult, parse } from "@babel/parser";
import traverse from "@babel/traverse";

const upperFirst = (str: string) => str.charAt(0).toUpperCase() + str.slice(1);

/**
 * Converts a local variable declaration to a state assignment.
 * 
 * i.e.
 * 
 * let a: number = 0;
 * 
 * to
 * 
 * state.a = 0;
 */
const localVariableConstructorInstantiation = (declarator: t.VariableDeclarator): t.Expression => {
    if (declarator.id.type !== "Identifier") {
        throw new Error("Unsupported local variable declaration to state assignment conversion. " + JSON.stringify(declarator, null, 4));
    }

    const declaration = declarator.id as t.Identifier;
    if (declaration.typeAnnotation && t.isTSTypeAnnotation(declaration.typeAnnotation)) {
        switch (declaration.typeAnnotation.typeAnnotation.type) {
            case "TSNumberKeyword":
                return t.numericLiteral(0);
            case "TSStringKeyword":
                return t.stringLiteral("");
            case "TSBooleanKeyword":
                return t.booleanLiteral(false);
            case "TSAnyKeyword":
                return t.buildUndefinedNode();
            case "TSArrayType":
                return t.arrayExpression([]);
            case "TSUnionType":
                return t.objectExpression([]);
            case "TSTypeReference":
                return t.objectExpression([]);
            default:
                throw new Error("Unsupported local variable declaration to state assignment conversion for given type. " + JSON.stringify(declarator, null, 4));
        }
    } else {
        return t.buildUndefinedNode();
    }
}

const getParameterName = (parameter: t.Identifier | t.Pattern | t.RestElement): string => {
    if (t.isIdentifier(parameter)) {
        return parameter.name;
    }
    if (t.isAssignmentPattern(parameter)) {
        if (t.isIdentifier(parameter.left)) {
            return getParameterName(parameter.left);
        }
    }
    if (t.isRestElement(parameter)) {
        if (t.isIdentifier(parameter.argument)) {
            return getParameterName(parameter.argument);
        }
    }
    throw new Error("Unsupported parameter type: " + JSON.stringify(parameter, null, 4));
}

const getParameterType = (parameter: t.Identifier | t.Pattern | t.RestElement): t.TypeAnnotation | t.TSTypeAnnotation | t.Noop | null | undefined => {
    if (t.isIdentifier(parameter)) {
        return parameter.typeAnnotation || t.tsTypeAnnotation(t.tsAnyKeyword());
    }
    if (t.isAssignmentPattern(parameter)) {
        if (t.isIdentifier(parameter.left)) {
            return getParameterType(parameter.left);
        }
    }
    if (t.isRestElement(parameter)) {
        return parameter.typeAnnotation || t.tsTypeAnnotation(t.tsArrayType(t.tsAnyKeyword()));
    }
    throw new Error("Unsupported parameter type: " + JSON.stringify(parameter, null, 4));
}

const isParameterOptional = (parameter: t.Identifier | t.Pattern | t.RestElement): boolean => {
    if (t.isIdentifier(parameter)) {
        return parameter.optional || false;
    }
    if (t.isAssignmentPattern(parameter)) {
        if (t.isIdentifier(parameter.left)) {
            return isParameterOptional(parameter.left);
        }
    }
    if (t.isRestElement(parameter)) {
        // Rest parameters cannot be optional
        return false;
    }
    throw new Error("Unsupported parameter type, cannot parse if is optional: " + JSON.stringify(parameter, null, 4));
}

/**
 * Generates the state property for the state machine. State is comprised of:
 * - parameters of the generator function
 * - local variables declared within the generator function
 * - nextStep driving iteration through the state machine
 */
const generateStateProperty = (generatorComponents: GeneratorComponents, stateMembersTypes: t.TSTypeElement[]): t.ClassProperty => {
    return {
        type: "ClassProperty",
        computed: false,
        static: false,
        accessibility: "private",
        key: t.identifier("state"),
        typeAnnotation: t.tsTypeAnnotation(t.tsTypeLiteral(stateMembersTypes)),
    }
}

/**
 * Generates the constructor for the state machine with parameters from the original generator as well as
 * default local variable initiation (i.e. number = 0, string = "", boolean = false, etc.)
 */
const generateConstructor = (generatorComponents: GeneratorComponents): t.ClassMethod => {

    const constructorStateAssignments = t.objectExpression([
        t.objectProperty(
            t.identifier("nextStep"),
            t.numericLiteral(0),
        ),
        ...generatorComponents.parameters.map((parameter) =>
            t.objectProperty(
                t.identifier(getParameterName(parameter)),
                t.identifier(getParameterName(parameter)),
            )),
        ...generatorComponents.localVariables.flatMap(localVar => localVar.declarations).map((declarator) =>
            t.objectProperty(
                t.identifier((declarator.id as t.Identifier).name),
                t.tsInstantiationExpression(localVariableConstructorInstantiation(declarator))
            )),
    ]);

    return t.classMethod(
        "constructor",
        t.identifier("constructor"),
        generatorComponents.parameters,
        t.blockStatement([
            t.expressionStatement(
                t.assignmentExpression(
                    "=",
                    t.memberExpression(
                        t.thisExpression(),
                        t.identifier("state"),
                    ),
                    constructorStateAssignments
                )
            )
        ])
    )
}


/**
 * Generates the saveState() method for the state machine.
 *
 * note: t.classMethod does not expose return type, so we have to use raw node construction
 */
const generateSaveStateMethod = (generatorComponents: GeneratorComponents, stateMemberTypes: t.TSTypeElement[]): t.ClassMethod => {
    return {
        type: "ClassMethod",
        kind: "method",
        computed: false,
        static: false,
        generator: false,
        async: false,
        key: t.identifier("saveState"),
        params: [],
        returnType: t.tsTypeAnnotation(t.tsTypeLiteral(stateMemberTypes)),
        body: t.blockStatement([
            t.returnStatement(
                t.objectExpression([
                    t.spreadElement(
                        t.memberExpression(
                            t.thisExpression(),
                            t.identifier("state"),
                        )
                    )
                ])
            )
        ])
    }
}

/**
 * Generates the loadState() method for the state machine.
 *
 * note: t.classMethod does not expose type param for params, so we have to mix raw node construction
 */
const generateLoadStateMethod = (generatorComponents: GeneratorComponents, stateMemberTypes: t.TSTypeElement[]): t.ClassMethod => {
    return {
        type: "ClassMethod",
        kind: "method",
        computed: false,
        static: false,
        generator: false,
        async: false,
        key: t.identifier("loadState"),
        params: [
            {
                type: "Identifier",
                name: "state",
                typeAnnotation: {
                    type: "TSTypeAnnotation",
                    typeAnnotation: {
                        type: "TSObjectKeyword",
                    }
                }
            }
        ],
        returnType: t.tsTypeAnnotation(t.tsVoidKeyword()),
        body: t.blockStatement(
            [
                t.expressionStatement(
                    t.assignmentExpression(
                        "=",
                        t.memberExpression(
                            t.thisExpression(),
                            t.identifier("state"),
                        ),
                        t.objectExpression([
                            t.spreadElement(
                                t.tsAsExpression(
                                    t.identifier("state"),
                                    t.tsTypeLiteral(stateMemberTypes)
                                )
                            )
                        ])
                    )
                )
            ]
        )
    }
}

const generateNextStepMethod = (generatorComponents: GeneratorComponents, identifyNamesToBeReplacedWithState: string[]): t.ClassMethod => {

    const replacer = new Replacer(identifyNamesToBeReplacedWithState);

    const stateMachineCases = generatorComponents.steps.map((step, index) => {
        const isLastStep = index === generatorComponents.steps.length - 1;
        const incrementNextStepStatement = t.expressionStatement(
            t.assignmentExpression(
                "=",
                t.memberExpression(
                    t.memberExpression(
                        t.thisExpression(),
                        t.identifier("state"),
                    ),
                    t.identifier("nextStep"),
                ),
                t.numericLiteral(index + 1),
            )
        );
        const returnStatement =
            t.returnStatement(
                t.objectExpression([
                    // Improvements to replacement typing needed before migrating away from raw node
                    {
                        type: "ObjectProperty",
                        key: t.identifier("value"),
                        value: step.returnExpression ? replacer.replaceIdentifiersWithStateMemberAccess(step.returnExpression) : null
                    } as t.ObjectProperty,
                    t.objectProperty(
                        t.identifier("done"),
                        t.booleanLiteral(isLastStep),
                    ),
                ])
            );

        const replacedYieldedExpression = step.startingYield ?
            replacer.replaceLocalVariableWithState(replacer.replaceYieldInStatementWithValue(step.startingYield)) : [];
        const consequent = isLastStep ?
            [...replacedYieldedExpression, ...step.statements.flatMap(replacer.replaceLocalVariableWithState), returnStatement] :
            [...replacedYieldedExpression, ...step.statements.flatMap(replacer.replaceLocalVariableWithState), incrementNextStepStatement, returnStatement];
        return {
            type: "SwitchCase",
            test: t.numericLiteral(index),
            consequent: consequent,
        }
    });

    return {
        type: "ClassMethod",
        kind: "method",
        computed: false,
        static: false,
        generator: false,
        async: false,
        key: t.identifier("nextStep"),
        params: [
            {
                type: "Identifier",
                name: "value",
                typeAnnotation: {
                    type: "TSTypeAnnotation",
                    typeAnnotation: generatorComponents.nextStepParamType,
                }
            }
        ],
        returnType: t.tsTypeAnnotation(
            t.tsTypeReference(t.identifier("IteratorResult"), t.tsTypeParameterInstantiation([
                generatorComponents.yieldType,
                generatorComponents.returnType
            ]))
        ),
        body: t.blockStatement(
            [
                {
                    type: "SwitchStatement",
                    discriminant: t.memberExpression(
                        t.memberExpression(
                            t.thisExpression(),
                            t.identifier("state"),
                        ),
                        t.identifier("nextStep"),
                    ),
                    cases: [
                        ...stateMachineCases as t.SwitchCase[],
                        t.switchCase(
                            null,
                            [t.throwStatement(t.newExpression(t.identifier("Error"), [t.stringLiteral("Invalid next step")]))]
                        )
                    ]
                }
            ]
        )
    }
}

/**
 * Generates a Generator class (as a code string) from the parsed components of a generator function.
 */
export function generateSerializableStateMachine(generatorComponents: GeneratorComponents): string {

    const localVariableStateMembers = generatorComponents.localVariables.flatMap(localVar => localVar.declarations).map((declaration) => ({
        type: "TSPropertySignature",
        key: t.identifier((declaration.id as t.Identifier).name),
        typeAnnotation: (declaration.id as t.Identifier).typeAnnotation,
        optional: (declaration.id as t.Identifier).optional || false
    }));
    const parameterStateMembers = generatorComponents.parameters.map((parameter) => ({
        type: "TSPropertySignature",
        key: t.identifier(getParameterName(parameter)),
        typeAnnotation: getParameterType(parameter),
        optional: isParameterOptional(parameter)
    }));

    const stateMembersTypes = [
        // nextStep
        t.tsPropertySignature(
            t.identifier("nextStep"),
            t.tsTypeAnnotation(t.tsNumberKeyword()),
        ),
        ...localVariableStateMembers,
        ...parameterStateMembers,
    ] as t.TSTypeElement[];

    const identifyNamesToBeReplacedWithState = [
        ...localVariableStateMembers.map(member => member.key.name),
        ...parameterStateMembers.map(member => member.key.name),
    ];

    const ast = t.file(
        t.program(
            [
                t.classDeclaration(t.identifier(upperFirst(generatorComponents.name) + "Generator"),
                    null,
                    t.classBody(
                        [
                            generateStateProperty(generatorComponents, stateMembersTypes),
                            generateConstructor(generatorComponents),
                            generateSaveStateMethod(generatorComponents, stateMembersTypes),
                            generateLoadStateMethod(generatorComponents, stateMembersTypes),
                            generateNextStepMethod(generatorComponents, identifyNamesToBeReplacedWithState),
                        ]
                    )
                )
            ]
        )
    );

    const output = generate(
        ast as t.File
    );

    const fullAst = parse(output.code, {
        sourceType: "module",
        plugins: [
            "typescript",
        ]
    });

    traverse(fullAst as ParseResult<t.File>, {
        enter(path) {
            if (t.isClassMethod(path.node) && t.isIdentifier(path.node.key) && path.node.key.name === "nextStep") {
                path.traverse({
                    enter(innerPath) {
                        // Replace all usages of local variables with state member access
                        if (t.isIdentifier(innerPath.node) && identifyNamesToBeReplacedWithState.includes(innerPath.node.name) && !t.isMemberExpression(innerPath.parent)) {
                            innerPath.replaceWith(t.memberExpression(
                                t.memberExpression(
                                    t.thisExpression(),
                                    t.identifier("state"),
                                ),
                                t.identifier(innerPath.node.name),
                            ))
                        }
                    }
                })
            }
        }
    });

    return generate(fullAst as t.File).code;
}