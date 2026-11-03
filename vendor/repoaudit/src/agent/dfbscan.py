import json
import math
import os
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import replace
from pathlib import Path
from typing import Any, Dict, List, Optional, TextIO, Tuple
from tqdm import tqdm

from agent.agent import *

from tstool.analyzer.TS_analyzer import *
from tstool.analyzer.Cpp_TS_analyzer import *
from tstool.analyzer.Go_TS_analyzer import *
from tstool.analyzer.Java_TS_analyzer import *
from tstool.analyzer.Python_TS_analyzer import *

from tstool.dfbscan_extractor.dfbscan_extractor import *
from tstool.dfbscan_extractor.Cpp.Cpp_MLK_extractor import *
from tstool.dfbscan_extractor.Cpp.Cpp_NPD_extractor import *
from tstool.dfbscan_extractor.Cpp.Cpp_UAF_extractor import *
from tstool.dfbscan_extractor.Java.Java_NPD_extractor import *
from tstool.dfbscan_extractor.Python.Python_NPD_extractor import *
from tstool.dfbscan_extractor.Go.Go_NPD_extractor import *

from llmtool.LLM_utils import *
from llmtool.dfbscan.intra_dataflow_analyzer import *
from llmtool.dfbscan.path_validator import *

from memory.semantic.dfbscan_state import *
from memory.syntactic.function import *
from memory.syntactic.value import *

from ui.logger import *

from memory.report.bug_report import BugReport
from protocol import (
    AnalysisEvent,
    AuditCandidate,
    AuditRun,
    DataFlowPath,
    EventWriter,
    StructuredError,
    ValidationResult,
    new_run_id,
    utc_now,
    validate_run_id,
)
from service import (
    analyze_candidate,
    extract_candidates,
    inspect_repository,
    validate_path,
)
from service.analysis_service import _load_candidate_context
from storage import RunStore, RunStoreError

BASE_PATH = Path(__file__).resolve().parents[2]


class DFBScanAgent(Agent):
    def __init__(
        self,
        bug_type: str,
        is_reachable: bool,
        project_path: str,
        language: str,
        ts_analyzer: TSAnalyzer,
        model_name: str,
        temperature: float,
        call_depth: int,
        max_neural_workers: int = 1,
        agent_id: int = 0,
        run_id: Optional[str] = None,
    ) -> None:
        self.bug_type = bug_type
        self.is_reachable = is_reachable

        self.project_path = project_path
        self.project_name = Path(project_path).resolve().name
        self.language = language if language not in {"C", "Cpp"} else "Cpp"
        self.ts_analyzer = ts_analyzer

        self.model_name = model_name
        self.temperature = temperature

        self.call_depth = call_depth
        self.max_neural_workers = max_neural_workers
        self.MAX_QUERY_NUM = 5
        self.run_id = None if run_id is None else validate_run_id(run_id)

        self.lock = threading.Lock()

        with self.lock:
            artifact_id = self.run_id or (
                time.strftime("%Y-%m-%d-%H-%M-%S", time.localtime())
                + f"-{agent_id}"
            )
            self.log_dir_path = f"{BASE_PATH}/log/dfbscan/{self.model_name}/{self.bug_type}/{self.language}/{self.project_name}/{artifact_id}"
            self.res_dir_path = f"{BASE_PATH}/result/dfbscan/{self.model_name}/{self.bug_type}/{self.language}/{self.project_name}/{artifact_id}"
            if not os.path.exists(self.log_dir_path):
                os.makedirs(self.log_dir_path)
            self.logger = Logger(self.log_dir_path + "/" + "dfbscan.log")
            if self.run_id is not None:
                self.logger.print_log("RepoAudit run ID:", self.run_id)

            if not os.path.exists(self.res_dir_path):
                os.makedirs(self.res_dir_path)

        # LLM tools used by DFBScanAgent
        self.intra_dfa = IntraDataFlowAnalyzer(
            self.model_name,
            self.temperature,
            self.language,
            self.MAX_QUERY_NUM,
            self.logger,
        )
        self.path_validator = PathValidator(
            self.model_name,
            self.temperature,
            self.language,
            self.MAX_QUERY_NUM,
            self.logger,
        )

        self.src_values, self.sink_values = self.__obtain_extractor().extract_all()
        self.state = DFBScanState(self.src_values, self.sink_values)
        return

    def __obtain_extractor(self) -> DFBScanExtractor:
        if self.language == "Cpp":
            if self.bug_type == "MLK":
                return Cpp_MLK_Extractor(self.ts_analyzer)
            elif self.bug_type == "NPD":
                return Cpp_NPD_Extractor(self.ts_analyzer)
            elif self.bug_type == "UAF":
                return Cpp_UAF_Extractor(self.ts_analyzer)
        elif self.language == "Java":
            if self.bug_type == "NPD":
                return Java_NPD_Extractor(self.ts_analyzer)
        elif self.language == "Python":
            if self.bug_type == "NPD":
                return Python_NPD_Extractor(self.ts_analyzer)
        elif self.language == "Go":
            if self.bug_type == "NPD":
                return Go_NPD_Extractor(self.ts_analyzer)
        raise NotImplementedError(
            f"Unsupported bug type: {self.bug_type} in {self.language}"
        )

    def __update_worklist(
        self,
        input: IntraDataFlowAnalyzerInput,
        output: IntraDataFlowAnalyzerOutput,
        call_context: CallContext,
        path_index: int,
    ) -> List[Tuple[Value, Function, CallContext]]:
        """
        Update the worklist based on the output of intra-procedural data-flow analysis.
        :param input: The input of intra-procedural data-flow analysis
        :param output: The output of intra-procedural data-flow analysis
        :param call_context: The call context of the current function
        :return: The updated worklist
        """
        delta_worklist = []  # The list of (value, function, call_context) tuples
        function_id = input.function.function_id
        function = self.ts_analyzer.function_env[function_id]

        for value in output.reachable_values[path_index]:
            if value.label == ValueLabel.ARG:
                callee_functions = self.ts_analyzer.get_all_callee_functions(function)
                for callee_function in callee_functions:
                    is_called = False
                    call_sites = self.ts_analyzer.get_callsites_by_callee_name(
                        function, callee_function.function_name
                    )
                    call_site_line_number = -1
                    for call_site_node in call_sites:
                        file_content = self.ts_analyzer.code_in_files[
                            function.file_path
                        ]
                        call_site_lower_line_number = (
                            file_content[: call_site_node.start_byte].count("\n") + 1
                        )
                        call_site_upper_line_number = (
                            file_content[: call_site_node.end_byte].count("\n") + 1
                        )
                        arg_line_number_in_file = value.line_number
                        if (
                            call_site_lower_line_number <= arg_line_number_in_file
                            and arg_line_number_in_file <= call_site_upper_line_number
                        ):
                            is_called = True
                            call_site_line_number = call_site_lower_line_number
                    if not is_called:
                        continue

                    new_call_context = copy.deepcopy(call_context)
                    context_label = ContextLabel(
                        self.ts_analyzer.functionToFile[function.function_id],
                        call_site_line_number,
                        callee_function.function_id,
                        Parenthesis.LEFT_PAR,
                    )
                    is_CFL_reachable = new_call_context.add_and_check_context(
                        context_label
                    )
                    if not is_CFL_reachable:
                        continue

                    if callee_function.paras is not None:
                        for para in callee_function.paras:
                            if para.index == value.index:
                                delta_worklist.append(
                                    (para, callee_function, new_call_context)
                                )
                                self.state.update_external_value_match(
                                    (value, call_context),
                                    set({(para, new_call_context)}),
                                )

            if value.label == ValueLabel.PARA:
                # Consider side-effect.
                # Example: the parameter *p is used in the function: p->f = null;
                # We need to consider the side-effect of p.
                caller_functions = self.ts_analyzer.get_all_caller_functions(function)
                for caller_function in caller_functions:
                    new_call_context = copy.deepcopy(call_context)
                    top_unmatched_context_label = (
                        new_call_context.get_top_unmatched_context_label()
                    )

                    call_site_nodes = self.ts_analyzer.get_callsites_by_callee_name(
                        caller_function, function.function_name
                    )
                    for call_site_node in call_site_nodes:
                        caller_function_file_name = self.ts_analyzer.functionToFile[
                            caller_function.function_id
                        ]
                        file_content = self.ts_analyzer.code_in_files[
                            caller_function_file_name
                        ]
                        call_site_lower_line_number = (
                            file_content[: call_site_node.start_byte].count("\n") + 1
                        )

                        if top_unmatched_context_label is not None:
                            if (
                                top_unmatched_context_label.parenthesis
                                == Parenthesis.LEFT_PAR
                            ):
                                if (
                                    call_site_lower_line_number
                                    != top_unmatched_context_label.line_number
                                    or caller_function_file_name
                                    != top_unmatched_context_label.file_name
                                    or top_unmatched_context_label.function_id
                                    != function.function_id
                                ):
                                    continue

                        append_context_label = ContextLabel(
                            caller_function_file_name,
                            call_site_lower_line_number,
                            function.function_id,
                            Parenthesis.RIGHT_PAR,
                        )
                        new_call_context.add_and_check_context(append_context_label)

                        args = self.ts_analyzer.get_arguments_at_callsite(
                            caller_function, call_site_node
                        )
                        for arg in args:
                            if arg.index == value.index:
                                delta_worklist.append(
                                    (arg, caller_function, new_call_context)
                                )
                                self.state.update_external_value_match(
                                    (value, call_context),
                                    set({(arg, new_call_context)}),
                                )

            if value.label == ValueLabel.RET:
                caller_functions = self.ts_analyzer.get_all_caller_functions(function)
                for caller_function in caller_functions:
                    new_call_context = copy.deepcopy(call_context)
                    top_unmatched_context_label = (
                        new_call_context.get_top_unmatched_context_label()
                    )

                    call_site_nodes = self.ts_analyzer.get_callsites_by_callee_name(
                        caller_function, function.function_name
                    )
                    for call_site_node in call_site_nodes:
                        caller_function_file_name = self.ts_analyzer.functionToFile[
                            caller_function.function_id
                        ]
                        file_content = self.ts_analyzer.code_in_files[
                            caller_function_file_name
                        ]
                        call_site_lower_line_number = (
                            file_content[: call_site_node.start_byte].count("\n") + 1
                        )

                        if top_unmatched_context_label is not None:
                            if (
                                top_unmatched_context_label.parenthesis
                                == Parenthesis.LEFT_PAR
                            ):
                                if (
                                    call_site_lower_line_number
                                    != top_unmatched_context_label.line_number
                                    or caller_function_file_name
                                    != top_unmatched_context_label.file_name
                                    or top_unmatched_context_label.function_id
                                    != function.function_id
                                ):
                                    continue

                        append_context_label = ContextLabel(
                            caller_function_file_name,
                            call_site_lower_line_number,
                            function.function_id,
                            Parenthesis.RIGHT_PAR,
                        )
                        new_call_context.add_and_check_context(append_context_label)

                        output_value = self.ts_analyzer.get_output_value_at_callsite(
                            caller_function, call_site_node
                        )
                        delta_worklist.append(
                            (output_value, caller_function, new_call_context)
                        )
                        self.state.update_external_value_match(
                            (value, call_context),
                            set({(output_value, new_call_context)}),
                        )

            if value.label == ValueLabel.SINK:
                # No need to continue the exploration
                pass
        return delta_worklist

    def __collect_potential_buggy_paths(
        self,
        src_value: Value,
        current_value_with_context: Tuple[Value, CallContext],
        path_with_unknown_status: List[Value] = [],
    ) -> None:
        """
        Recursively collect potential buggy paths based on the propagation details.

        This function updates the state with buggy paths if the propagation from the source
        meets the criteria based on the bug type (reachability). If the current_value_with_context
        is neither in reachable values nor in external value matches, it returns immediately.

        Args:
            src_value (Value):
                The source value from which the propagation starts.
            current_value_with_context (Tuple[Value, CallContext]):
                The current value along with its call context.
            path_with_unknown_status (List[Value], optional):
                The propagation path accumulated so far.
        """
        reachable_values_snapshot = self.state.reachable_values_per_path
        external_match_snapshot = self.state.external_value_match

        # If no propagation information exists for the current value, stop further processing.
        if (
            current_value_with_context not in reachable_values_snapshot
            and current_value_with_context not in external_match_snapshot
        ):
            return

        # Process if the current value has reachable paths.
        if current_value_with_context in reachable_values_snapshot:
            reachable_values_paths: List[Set[Tuple[Value, CallContext]]] = (
                reachable_values_snapshot[current_value_with_context]
            )
            for path_set in reachable_values_paths:
                if not path_set:
                    # For memory leak-style bug types we only update when the path is empty.
                    if not self.is_reachable:
                        self.state.update_potential_buggy_paths(
                            src_value, path_with_unknown_status + [src_value]
                        )
                    continue
                for value, ctx in path_set:
                    if value.label == ValueLabel.SINK:
                        # For NPD-style bug types
                        if self.is_reachable:
                            self.state.update_potential_buggy_paths(
                                src_value, path_with_unknown_status + [value]
                            )
                    elif value.label in {
                        ValueLabel.PARA,
                        ValueLabel.RET,
                        ValueLabel.ARG,
                        ValueLabel.OUT,
                    }:
                        # For other propagation types, check further external matches.
                        if (value, ctx) in external_match_snapshot:
                            for value_next, ctx_next in external_match_snapshot[
                                (value, ctx)
                            ]:
                                self.__collect_potential_buggy_paths(
                                    src_value,
                                    (value_next, ctx_next),
                                    path_with_unknown_status + [value, value_next],
                                )

        # Process if the current value has external value matches.
        if current_value_with_context in external_match_snapshot:
            for value_next, ctx_next in external_match_snapshot[
                current_value_with_context
            ]:
                value, _ = current_value_with_context
                self.__collect_potential_buggy_paths(
                    src_value,
                    (value_next, ctx_next),
                    path_with_unknown_status + [value, value_next],
                )
        return

    # TOBE deprecated
    def start_scan_sequential(self) -> None:
        self.logger.print_console("Start data-flow bug scanning...")

        # Total number of source values
        total_src_values = len(self.src_values)

        # Process each source value sequentially with a progress bar
        with tqdm(
            total=total_src_values, desc="Processing Source Values", unit="src"
        ) as pbar:
            for src_value in self.src_values:
                worklist = []
                src_function = self.ts_analyzer.get_function_from_localvalue(src_value)
                if src_function is None:
                    pbar.update(1)
                    continue

                initial_context = CallContext(False)
                worklist.append((src_value, src_function, initial_context))

                while len(worklist) > 0:
                    (start_value, start_function, call_context) = worklist.pop(0)
                    if len(call_context.context) >= self.call_depth:
                        continue

                    # Construct the input for intra-procedural data-flow analysis
                    sinks_in_function = self.__obtain_extractor().extract_sinks(
                        start_function
                    )
                    sink_values = [
                        (
                            sink.name,
                            sink.line_number - start_function.start_line_number + 1,
                        )
                        for sink in sinks_in_function
                    ]

                    call_statements = []
                    for call_site_node in start_function.function_call_site_nodes:
                        file_content = self.ts_analyzer.code_in_files[
                            start_function.file_path
                        ]
                        call_site_line_number = (
                            file_content[: call_site_node.start_byte].count("\n") + 1
                        )
                        call_site_name = file_content[
                            call_site_node.start_byte : call_site_node.end_byte
                        ]
                        call_statements.append((call_site_name, call_site_line_number))

                    ret_values = [
                        (
                            ret.name,
                            ret.line_number - start_function.start_line_number + 1,
                        )
                        for ret in (
                            start_function.retvals
                            if start_function.retvals is not None
                            else []
                        )
                    ]
                    df_input = IntraDataFlowAnalyzerInput(
                        start_function,
                        start_value,
                        sink_values,
                        call_statements,
                        ret_values,
                    )

                    # Invoke the intra-procedural data-flow analysis
                    df_output = self.intra_dfa.invoke(
                        df_input, IntraDataFlowAnalyzerOutput
                    )
                    if df_output is None:
                        continue

                    for path_index in range(len(df_output.reachable_values)):
                        reachable_values_in_single_path = set([])
                        for value in df_output.reachable_values[path_index]:
                            reachable_values_in_single_path.add((value, call_context))
                        self.state.update_reachable_values_per_path(
                            (start_value, call_context), reachable_values_in_single_path
                        )

                        delta_worklist = self.__update_worklist(
                            df_input, df_output, call_context, path_index
                        )
                        worklist.extend(delta_worklist)

                self.__collect_potential_buggy_paths(
                    src_value, (src_value, CallContext(False))
                )

                if src_value not in self.state.potential_buggy_paths:
                    pbar.update(1)
                    continue

                for buggy_path in self.state.potential_buggy_paths[src_value].values():
                    pv_input = PathValidatorInput(
                        self.bug_type,
                        buggy_path,
                        {
                            value: self.ts_analyzer.get_function_from_localvalue(value)
                            for value in buggy_path
                        },
                    )
                    pv_output = self.path_validator.invoke(
                        pv_input, PathValidatorOutput
                    )

                    if pv_output is None:
                        continue

                    if pv_output.is_reachable:
                        relevant_functions = {}
                        for value in buggy_path:
                            function = self.ts_analyzer.get_function_from_localvalue(
                                value
                            )
                            if function is not None:
                                relevant_functions[function.function_id] = function

                        bug_report = BugReport(
                            self.bug_type,
                            src_value,
                            relevant_functions,
                            pv_output.explanation_str,
                        )
                        self.state.update_bug_report(bug_report)

                # Dump bug reports
                bug_report_dict = {
                    bug_report_id: bug.to_dict()
                    for bug_report_id, bug in self.state.bug_reports.items()
                }
                with open(
                    self.res_dir_path + "/detect_info.json", "w"
                ) as bug_info_file:
                    json.dump(bug_report_dict, bug_info_file, indent=4)

                # Update the progress bar
                pbar.update(1)

        # Final summary
        total_bug_number = len(self.state.bug_reports.values())
        self.logger.print_console(
            f"{total_bug_number} bug(s) was/were detected in total."
        )
        self.logger.print_console(
            f"The bug report(s) has/have been dumped to {self.res_dir_path}/detect_info.json"
        )
        self.logger.print_console("The log files are as follows:")
        for log_file in self.get_log_files():
            self.logger.print_console(log_file)
        return

    def start_scan(self) -> None:
        self.logger.print_console("Start data-flow bug scanning in parallel...")
        self.logger.print_console(f"Max number of workers: {self.max_neural_workers}")

        # Total number of source values
        total_src_values = len(self.src_values)

        # Process each source value in parallel with a progress bar
        with tqdm(
            total=total_src_values, desc="Processing Source Values", unit="src"
        ) as pbar:
            with ThreadPoolExecutor(max_workers=self.max_neural_workers) as executor:
                futures = [
                    executor.submit(self.__process_src_value, src_value)
                    for src_value in self.src_values
                ]
                for future in as_completed(futures):
                    try:
                        future.result()
                    except Exception as e:
                        self.logger.print_log("Error processing source value:", e)
                    finally:
                        # Update the progress bar after each source value is processed
                        pbar.update(1)

        # Final summary
        total_bug_number = len(self.state.bug_reports.values())
        self.logger.print_console(
            f"{total_bug_number} bug(s) was/were detected in total."
        )
        self.logger.print_console(
            f"The bug report(s) has/have been dumped to {self.res_dir_path}/detect_info.json"
        )
        self.logger.print_console("The log files are as follows:")
        for log_file in self.get_log_files():
            self.logger.print_console(log_file)
        return

    def __process_src_value(self, src_value: Value) -> None:
        worklist = []
        src_function = self.ts_analyzer.get_function_from_localvalue(src_value)
        if src_function is None:
            return
        initial_context = CallContext(False)

        worklist.append((src_value, src_function, initial_context))
        while len(worklist) > 0:
            (start_value, start_function, call_context) = worklist.pop(0)
            if len(call_context.context) > self.call_depth:
                continue

            # Construct the input for intra-procedural data-flow analysis
            sinks_in_function = self.__obtain_extractor().extract_sinks(start_function)
            sink_values = [
                (sink.name, sink.line_number - start_function.start_line_number + 1)
                for sink in sinks_in_function
            ]

            call_statements = []
            for call_site_node in start_function.function_call_site_nodes:
                file_content = self.ts_analyzer.code_in_files[start_function.file_path]
                call_site_line_number = (
                    file_content[: call_site_node.start_byte].count("\n") + 1
                )
                call_site_name = file_content[
                    call_site_node.start_byte : call_site_node.end_byte
                ]
                call_statements.append((call_site_name, call_site_line_number))

            ret_values = [
                (ret.name, ret.line_number - start_function.start_line_number + 1)
                for ret in (
                    start_function.retvals if start_function.retvals is not None else []
                )
            ]
            df_input = IntraDataFlowAnalyzerInput(
                start_function, start_value, sink_values, call_statements, ret_values
            )

            # Invoke the intra-procedural data-flow analysis
            df_output = self.intra_dfa.invoke(df_input, IntraDataFlowAnalyzerOutput)

            if df_output is None:
                continue

            for path_index in range(len(df_output.reachable_values)):
                reachable_values_in_single_path = set([])
                for value in df_output.reachable_values[path_index]:
                    reachable_values_in_single_path.add((value, call_context))
                self.state.update_reachable_values_per_path(
                    (start_value, call_context), reachable_values_in_single_path
                )

                delta_worklist = self.__update_worklist(
                    df_input, df_output, call_context, path_index
                )
                worklist.extend(delta_worklist)

        # Collect potential buggy paths
        self.__collect_potential_buggy_paths(src_value, (src_value, CallContext(False)))

        # If no potential buggy paths are found, return early
        if src_value not in self.state.potential_buggy_paths:
            return

        # Validate buggy paths and generate bug reports
        for buggy_path in self.state.potential_buggy_paths[src_value].values():
            values_to_functions = {
                value: self.ts_analyzer.get_function_from_localvalue(value)
                for value in buggy_path
            }

            functions: Set[Function] = set()
            for func in values_to_functions.values():
                if func is not None:
                    functions.add(func)

            if self.state.check_existence(src_value, functions):
                continue

            pv_input = PathValidatorInput(
                self.bug_type,
                buggy_path,
                values_to_functions,
            )
            pv_output = self.path_validator.invoke(pv_input, PathValidatorOutput)

            if pv_output is None:
                continue

            if pv_output.is_reachable:
                relevant_functions = {}
                for value in buggy_path:
                    function = self.ts_analyzer.get_function_from_localvalue(value)
                    if function is not None:
                        relevant_functions[function.function_id] = function

                bug_report = BugReport(
                    self.bug_type,
                    src_value,
                    relevant_functions,
                    pv_output.explanation_str,
                )
                self.state.update_bug_report(bug_report)
                bug_report_dict = {
                    bug_report_id: bug.to_dict()
                    for bug_report_id, bug in self.state.bug_reports.items()
                }

                with open(
                    self.res_dir_path + "/detect_info.json", "w"
                ) as bug_info_file:
                    json.dump(bug_report_dict, bug_info_file, indent=4)
        return

    def get_agent_state(self) -> DFBScanState:
        return self.state

    def get_log_files(self) -> List[str]:
        log_files = []
        log_files.append(self.log_dir_path + "/" + "dfbscan.log")
        return log_files


class _SilentToolLogger:
    """Keep staged model prompts and raw responses out of legacy logs/stdout."""

    def print_log(self, *args: object) -> None:
        return None

    def print_console(self, *args: object) -> None:
        return None


class _TeeEventStream:
    """Mirror the structured event stream to stdout and one run JSONL file."""

    def __init__(self, primary: TextIO, event_file: Path) -> None:
        self.primary = primary
        self.event_file = event_file
        self._file: Optional[TextIO] = None
        self.open_error: Optional[OSError] = None
        self.mirror_error: Optional[OSError] = None

    def __enter__(self) -> "_TeeEventStream":
        try:
            self._file = self.event_file.open("a", encoding="utf-8", newline="\n")
        except OSError as error:
            self.open_error = error
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        if self._file is not None:
            try:
                self._file.close()
            except OSError as error:
                self.mirror_error = error
            self._file = None

    def write(self, text: str) -> int:
        self.primary.write(text)
        if self._file is not None:
            try:
                self._file.write(text)
            except OSError as error:
                self._disable_mirror(error)
        return len(text)

    def flush(self) -> None:
        self.primary.flush()
        if self._file is not None:
            try:
                self._file.flush()
                os.fsync(self._file.fileno())
            except OSError as error:
                self._disable_mirror(error)

    def _disable_mirror(self, error: OSError) -> None:
        self.mirror_error = error
        if self._file is not None:
            try:
                self._file.close()
            except OSError:
                pass
            self._file = None


class _RecordingEventWriter(EventWriter):
    """Record the actual emitted events while preserving EventWriter behavior."""

    def __init__(self, event_stream: TextIO) -> None:
        super().__init__(event_stream=event_stream, log_stream=sys.stderr)
        self.events: List[AnalysisEvent] = []
        self._record_lock = threading.Lock()

    def emit(
        self,
        event_type: str,
        run_id: Optional[str],
        payload: Optional[Dict[str, Any]] = None,
        candidate_id: Optional[str] = None,
        path_id: Optional[str] = None,
    ) -> AnalysisEvent:
        event = super().emit(
            event_type,
            run_id,
            payload=payload,
            candidate_id=candidate_id,
            path_id=path_id,
        )
        with self._record_lock:
            self.events.append(event)
        return event


def run_full_scan(
    project_path: str,
    language: str,
    bug_type: str,
    model_name: str,
    *,
    is_reachable: bool = False,
    temperature: float = 0.5,
    call_depth: int = 3,
    max_symbolic_workers: int = 4,
    max_neural_workers: int = 1,
    run_store: Optional[RunStore] = None,
    run_id: Optional[str] = None,
) -> AuditRun:
    """Compose the staged services into one compatibility-preserving scan."""

    _validate_staged_scan_inputs(
        project_path,
        language,
        bug_type,
        model_name,
        is_reachable,
        temperature,
        call_depth,
        max_symbolic_workers,
        max_neural_workers,
    )
    repository_root = Path(project_path).expanduser().resolve(strict=True)
    if not repository_root.is_dir():
        raise ValueError("project_path must resolve to a directory")
    run = AuditRun(
        run_id=new_run_id() if run_id is None else validate_run_id(run_id),
        repository_root=repository_root.as_posix(),
        language=language,
        bug_type=bug_type,
        stage="full_scan",
        status="running",
    )
    store = RunStore() if run_store is None else run_store
    if not isinstance(store, RunStore):
        raise TypeError("run_store must be a RunStore")

    try:
        run_directory = store.create_run(run)
    except RunStoreError as error:
        return _emit_unstored_failure(run, error.error)

    result_directory: Optional[Path] = None
    legacy_reports: Dict[str, Dict[str, Any]] = {}
    legacy_bug_reports: List[BugReport] = []
    candidates: List[AuditCandidate] = []
    paths: List[DataFlowPath] = []
    validations: List[ValidationResult] = []

    event_file = run_directory / "events.jsonl"
    with _TeeEventStream(sys.stdout, event_file) as event_stream:
        writer = _RecordingEventWriter(event_stream)
        writer.emit("run_started", run.run_id, payload={"run": run})
        try:
            _raise_event_mirror_error(event_stream)
            result_directory, log_file = _staged_artifact_paths(
                repository_root,
                model_name,
                bug_type,
                language,
                run.run_id,
            )
            fixed_logger = Logger(str(log_file))
            fixed_logger.print_log("Staged RepoAudit full scan started.", run.run_id)
            tool_logger = _SilentToolLogger()
            intra_analyzer = IntraDataFlowAnalyzer(
                model_name,
                temperature,
                language,
                5,
                tool_logger,
            )
            path_validator = PathValidator(
                model_name,
                temperature,
                language,
                5,
                tool_logger,
            )

            run = _advance_run(run, "inspect")
            store.save_run(run)
            repository = inspect_repository(
                repository_root,
                language,
                run_id=run.run_id,
                event_writer=writer,
                max_symbolic_workers=max_symbolic_workers,
            )
            store.save_repository(repository)

            run = _advance_run(run, "candidates")
            store.save_run(run)
            candidates = extract_candidates(
                repository,
                bug_type,
                event_writer=writer,
                max_symbolic_workers=max_symbolic_workers,
            )
            store.save_candidates(run.run_id, candidates)

            run = _advance_run(run, "analyze")
            store.save_run(run)
            for candidate in candidates:
                try:
                    candidate_paths = analyze_candidate(
                        run.run_id,
                        candidate.candidate_id,
                        intra_dataflow_analyzer=intra_analyzer,
                        event_writer=writer,
                        call_depth=call_depth,
                    )
                    paths.extend(candidate_paths)
                    store.save_paths(run.run_id, paths)
                except RunStoreError:
                    raise
                except Exception as error:
                    _ensure_failure_event(
                        writer,
                        run.run_id,
                        error,
                        "analyze",
                        candidate_id=candidate.candidate_id,
                        code="CANDIDATE_ANALYSIS_FAILED",
                        message="The candidate could not be analyzed.",
                    )
                    _persist_recorded_errors(store, run.run_id, writer)
                    continue

                run = _advance_run(run, "validate")
                store.save_run(run)
                for path in candidate_paths:
                    try:
                        validation = validate_path(
                            run.run_id,
                            candidate.candidate_id,
                            path.path_id,
                            path_validator=path_validator,
                            event_writer=writer,
                        )
                        validations.append(validation)
                        store.save_validations(run.run_id, validations)
                        if _validation_is_finding(validation, is_reachable):
                            try:
                                report = _legacy_report(
                                    repository,
                                    candidate,
                                    path,
                                    validation,
                                )
                                if report not in legacy_bug_reports:
                                    legacy_bug_reports.append(report)
                                    legacy_reports[str(len(legacy_reports))] = (
                                        report.to_dict()
                                    )
                            except Exception as error:
                                _ensure_failure_event(
                                    writer,
                                    run.run_id,
                                    error,
                                    "full_scan",
                                    candidate_id=candidate.candidate_id,
                                    path_id=path.path_id,
                                    code="LEGACY_RESULT_CONVERSION_FAILED",
                                    message=(
                                        "The accepted path could not be converted "
                                        "to the legacy result format."
                                    ),
                                )
                                _persist_recorded_errors(store, run.run_id, writer)
                    except RunStoreError:
                        raise
                    except Exception as error:
                        _ensure_failure_event(
                            writer,
                            run.run_id,
                            error,
                            "validate",
                            candidate_id=candidate.candidate_id,
                            path_id=path.path_id,
                            code="PATH_VALIDATION_FAILED",
                            message="The path could not be validated.",
                        )
                        _persist_recorded_errors(store, run.run_id, writer)
                        continue
                run = _advance_run(run, "analyze")
                store.save_run(run)
                _persist_recorded_errors(store, run.run_id, writer)

            _raise_event_mirror_error(event_stream)
            if result_directory is None:
                raise RuntimeError("staged result directory was not initialized")
            _write_legacy_results(result_directory, legacy_reports)
            completion_status = (
                "success_with_findings" if legacy_reports else "success_no_findings"
            )
            run = _complete_run(run, writer, failed=False)
            store.save_errors(run.run_id, _recorded_errors(writer, run.run_id))
            store.save_run(run)
            writer.emit(
                "run_completed",
                run.run_id,
                payload={
                    "status": completion_status,
                    "finding_count": len(legacy_reports),
                    "error_count": len(run.error_ids),
                },
            )
            try:
                fixed_logger.print_log(
                    "Staged RepoAudit full scan completed.",
                    run.run_id,
                    completion_status,
                )
                writer.write_log("RepoAudit staged result:", result_directory)
            except Exception:
                pass
            return run
        except Exception as error:
            _ensure_failure_event(writer, run.run_id, error, "full_scan")
            try:
                writer.write_log("RepoAudit staged full scan: FULL_SCAN_FAILED")
            except Exception:
                pass
            try:
                if result_directory is not None:
                    _write_legacy_results(result_directory, legacy_reports)
            except Exception:
                pass
            run = _complete_run(run, writer, failed=True)
            try:
                store.save_errors(run.run_id, _recorded_errors(writer, run.run_id))
                store.save_run(run)
            except Exception:
                pass
            writer.emit(
                "run_completed",
                run.run_id,
                payload={
                    "status": "failed",
                    "finding_count": len(legacy_reports),
                    "error_count": len(run.error_ids),
                },
            )
            if (
                event_stream.open_error is not None
                or event_stream.mirror_error is not None
            ):
                try:
                    store.save_events(run.run_id, writer.events)
                except Exception:
                    pass
            return run


def _validate_staged_scan_inputs(
    project_path: str,
    language: str,
    bug_type: str,
    model_name: str,
    is_reachable: bool,
    temperature: float,
    call_depth: int,
    max_symbolic_workers: int,
    max_neural_workers: int,
) -> None:
    if not isinstance(project_path, str) or not project_path.strip():
        raise ValueError("project_path must be a non-empty string")
    if not isinstance(language, str) or not language.strip():
        raise ValueError("language must be a non-empty string")
    if not isinstance(bug_type, str) or not bug_type.strip():
        raise ValueError("bug_type must be a non-empty string")
    if not isinstance(model_name, str) or not model_name.strip():
        raise ValueError("model_name must be a non-empty string")
    if not isinstance(is_reachable, bool):
        raise TypeError("is_reachable must be a boolean")
    if not isinstance(temperature, (int, float)) or isinstance(temperature, bool):
        raise TypeError("temperature must be numeric")
    if not math.isfinite(float(temperature)):
        raise ValueError("temperature must be finite")
    for value, name in (
        (max_symbolic_workers, "max_symbolic_workers"),
        (max_neural_workers, "max_neural_workers"),
    ):
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise ValueError(f"{name} must be a positive integer")
    if (
        not isinstance(call_depth, int)
        or isinstance(call_depth, bool)
        or call_depth < 0
    ):
        raise ValueError("call_depth must be a non-negative integer")
    for value, name in (
        (language, "language"),
        (bug_type, "bug_type"),
        (model_name, "model_name"),
    ):
        if value in {".", ".."} or "/" in value or "\\" in value:
            raise ValueError(f"{name} must be a single path component")


def _raise_event_mirror_error(event_stream: _TeeEventStream) -> None:
    error = event_stream.open_error or event_stream.mirror_error
    if error is not None:
        raise error


def _staged_artifact_paths(
    repository_root: Path,
    model_name: str,
    bug_type: str,
    language: str,
    run_id: Optional[str] = None,
) -> Tuple[Path, Path]:
    project_name = repository_root.name
    stamp = (
        validate_run_id(run_id)
        if run_id is not None
        else time.strftime("%Y-%m-%d-%H-%M-%S", time.localtime()) + "-0"
    )
    result_directory = (
        BASE_PATH
        / "result"
        / "dfbscan"
        / model_name
        / bug_type
        / language
        / project_name
        / stamp
    )
    log_directory = (
        BASE_PATH
        / "log"
        / "dfbscan"
        / model_name
        / bug_type
        / language
        / project_name
        / stamp
    )
    result_directory.mkdir(parents=True, exist_ok=True)
    log_directory.mkdir(parents=True, exist_ok=True)
    return result_directory, log_directory / "dfbscan.log"


def _advance_run(run: AuditRun, stage: str) -> AuditRun:
    return replace(run, stage=stage, status="running", updated_at=utc_now())


def _complete_run(
    run: AuditRun,
    writer: _RecordingEventWriter,
    *,
    failed: bool,
) -> AuditRun:
    errors = _recorded_errors(writer, run.run_id)
    now = utc_now()
    return replace(
        run,
        stage="full_scan",
        status="failed" if failed else "completed",
        updated_at=now,
        completed_at=now,
        error_ids=[error.error_id for error in errors],
    )


def _recorded_errors(
    writer: _RecordingEventWriter,
    run_id: str,
) -> List[StructuredError]:
    errors: Dict[str, StructuredError] = {}
    for event in writer.events:
        if event.event_type != "analysis_failed":
            continue
        error = event.payload.get("error")
        if isinstance(error, StructuredError) and error.run_id == run_id:
            errors[error.error_id] = error
    return sorted(errors.values(), key=lambda item: item.error_id)


def _persist_recorded_errors(
    store: RunStore,
    run_id: str,
    writer: _RecordingEventWriter,
) -> None:
    store.save_errors(run_id, _recorded_errors(writer, run_id))


def _ensure_failure_event(
    writer: _RecordingEventWriter,
    run_id: str,
    exception: Exception,
    failure_stage: str,
    *,
    candidate_id: Optional[str] = None,
    path_id: Optional[str] = None,
    code: str = "FULL_SCAN_FAILED",
    message: str = "The staged full scan could not be completed.",
) -> None:
    existing = getattr(exception, "error", None)
    if isinstance(existing, StructuredError):
        if any(
            event.event_type == "analysis_failed"
            and isinstance(event.payload.get("error"), StructuredError)
            and event.payload["error"].error_id == existing.error_id
            for event in writer.events
        ):
            return
        writer.emit(
            "analysis_failed",
            run_id,
            candidate_id=existing.candidate_id,
            path_id=existing.path_id,
            payload={"error": existing},
        )
        return
    error = StructuredError(
        code=code,
        message=message,
        stage=failure_stage,
        retriable=False,
        details={"failure_stage": failure_stage},
        run_id=run_id,
        candidate_id=candidate_id,
        path_id=path_id,
        cause_type=type(exception).__name__,
    )
    writer.emit(
        "analysis_failed",
        run_id,
        candidate_id=candidate_id,
        path_id=path_id,
        payload={"error": error},
    )


def _validation_is_finding(
    validation: ValidationResult,
    is_reachable: bool,
) -> bool:
    expected = "reachable" if is_reachable else "not_reachable"
    return validation.verdict == expected


def _legacy_report(
    repository,
    candidate: AuditCandidate,
    path: DataFlowPath,
    validation: ValidationResult,
) -> BugReport:
    context, _ = _load_candidate_context(candidate.run_id, candidate.candidate_id)
    source = candidate.source_sink_pair.source
    source_file = (Path(repository.repository_root) / source.relative_path).resolve(
        strict=True
    )
    buggy_value = Value(
        candidate.source_sink_pair.source_symbol,
        source.start_line,
        ValueLabel.SRC,
        str(source_file),
    )
    relevant_functions: Dict[int, Function] = {}
    for step in path.steps:
        if step.value is None:
            continue
        step_file = (
            Path(repository.repository_root) / step.location.relative_path
        ).resolve(strict=True)
        value = Value(
            step.value,
            step.location.start_line,
            ValueLabel.LOCAL,
            str(step_file),
        )
        function = context.analyzer.get_function_from_localvalue(value)
        if function is not None:
            relevant_functions[function.function_id] = function
    return BugReport(
        candidate.bug_type,
        buggy_value,
        relevant_functions,
        validation.summary,
    )


def _write_legacy_results(
    result_directory: Path,
    reports: Dict[str, Dict[str, Any]],
) -> None:
    destination = result_directory / "detect_info.json"
    temporary = result_directory / f".detect_info.{uuid.uuid4().hex}.tmp"
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(reports, stream, ensure_ascii=False, indent=4)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _emit_unstored_failure(run: AuditRun, error: StructuredError) -> AuditRun:
    writer = _RecordingEventWriter(sys.stdout)
    writer.emit("analysis_failed", run.run_id, payload={"error": error})
    failed = _complete_run(run, writer, failed=True)
    writer.emit(
        "run_completed",
        run.run_id,
        payload={"status": "failed", "finding_count": 0, "error_count": 1},
    )
    return failed
