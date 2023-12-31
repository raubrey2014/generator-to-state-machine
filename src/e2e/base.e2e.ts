import { ParseResult, parse } from "@babel/parser";
import { generateSerializableStateMachine } from "../serializer/generate/generator";
import { parseGenerators } from "../serializer/parse/parser";
import { File } from "@babel/types";
import { GeneratorComponents } from "../serializer/types";

export function parseAndGenerateStateMachineComponents(code: string): { ast: ParseResult<File>, generatorComponents: GeneratorComponents, stateMachine: string } {
    const ast = parse(code, { sourceType: "module", plugins: ["typescript"] });
    const generator = parseGenerators(ast)[0];
    const stateMachine = generateSerializableStateMachine(generator);

    return { ast, generatorComponents: generator, stateMachine };
}