# -*- coding: utf-8 -*-
"""
表单校验 + 提示词构造。

前端提交的 6 个必填信息：姓名、性别、年龄、学历、知识基础、学习习惯，
这里会先清洗校验，再拼成给 DeepSeek 的 system / user 消息。
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

# 必填项（键 -> 中文名）
REQUIRED_FIELDS = {
    "name": "姓名",
    "gender": "性别",
    "age": "年龄",
    "education": "学历",
    "knowledge_base": "知识基础",
    "study_habit": "学习习惯",
}

# 选填项：填了会让计划更精准
OPTIONAL_FIELDS = {
    "goal": "学习目标",
    "weekly_hours": "每周可投入时间",
    "duration": "计划周期",
    "preference": "偏好学习方式",
}

ALLOWED_GENDERS = {"男", "女", "其他", "不愿透露"}

MAX_LEN = {
    "name": 30,
    "gender": 10,
    "education": 24,
    "knowledge_base": 1500,
    "study_habit": 1500,
    "goal": 500,
    "weekly_hours": 60,
    "duration": 60,
    "preference": 300,
}


def _text(payload: Dict[str, Any], key: str) -> str:
    value = payload.get(key, "")
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        value = "、".join(str(v) for v in value)
    return str(value).strip()[: MAX_LEN.get(key, 500)]


def validate(payload: Any) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """返回 (清洗后的数据, 错误信息字典)。errors 为空表示校验通过。"""
    if not isinstance(payload, dict):
        return {}, {"_": "请求体必须是 JSON 对象。"}

    data: Dict[str, Any] = {}
    errors: Dict[str, str] = {}

    for key in list(REQUIRED_FIELDS) + list(OPTIONAL_FIELDS):
        data[key] = _text(payload, key)

    # 必填校验
    for key, label in REQUIRED_FIELDS.items():
        if not data[key]:
            errors[key] = f"请填写{label}"

    # 性别
    if data["gender"] and data["gender"] not in ALLOWED_GENDERS:
        data["gender"] = data["gender"][:6]  # 容错：允许自定义值

    # 年龄
    if data["age"]:
        try:
            age = int(float(data["age"]))
        except ValueError:
            errors["age"] = "年龄请填写数字"
        else:
            if not 5 <= age <= 100:
                errors["age"] = "年龄请填写 5 - 100 之间的数字"
            else:
                data["age"] = age

    # 字符长度下限，避免一句话敷衍导致计划质量差
    for key, minimum in (("knowledge_base", 4), ("study_habit", 4)):
        if not errors.get(key) and data[key] and len(data[key]) < minimum:
            errors[key] = f"{REQUIRED_FIELDS[key]}描述太短了，请再具体一些（至少 {minimum} 个字）"

    return data, errors


SYSTEM_PROMPT = """你是一位资深的个性化学习规划师，擅长成人教育、考试备考与职业技能提升。
你的任务：根据学员的真实情况，产出一份**可直接执行**的个性化学习计划。

写作要求：
1. 必须紧扣学员的「知识基础」和「学习习惯」做定制：起点低的降低坡度、多补基础；起点高的跳过入门、直接上强度；
   习惯早起/碎片时间/容易分心的，要把任务切成对应时长的块。
2. 计划要具体到「可执行」：写清楚每一阶段学什么、用什么资料、每周投入多少小时、怎么检验学会了。
   禁止出现“认真学习”“多加练习”这类没有信息量的空话。
3. 时间安排要和学员的年龄、学历、每周可投入时间相匹配，宁少勿虚，宁可少而能完成，也不要多而做不到。
4. 目标要可量化：给出明确的里程碑、自测方式和达标线。
5. 必须考虑现实阻力：如果学员自述容易拖延、时间碎片化，请给出对应的对策（如最小启动动作、番茄钟、打卡机制）。
6. 语言使用中文，语气专业、鼓励、务实。

输出格式（严格使用 Markdown，不要输出任何额外说明或代码块包裹整篇内容）：
# （学员姓名）的个性化学习计划
> 一句话概括这份计划的核心思路

## 一、学员画像分析
用 3-5 条要点分析该学员的优势、短板与关键突破口。

## 二、学习目标
- 总体目标（明确、可衡量）
- 阶段目标（2-4 个里程碑，含达标标准）

## 三、分阶段学习路线
用一个 Markdown 表格呈现：阶段 | 时间 | 学习内容 | 学习资料/方法 | 阶段验收标准

## 四、每周时间安排
用一个 Markdown 表格给出**一周七天**的具体安排：星期 | 时间段 | 学习内容 | 时长 | 备注
（要严格贴合学员每周可投入的时间总量与作息习惯）

## 五、每日执行清单
给出每天可以照做的动作清单，包含「最小启动动作」，降低开始的门槛。

## 六、学习方法与资源建议
针对该学员的学科/目标，给出具体的学习方法（如费曼技巧、间隔重复、主动回忆）和资源类型建议。

## 七、检查点与自我检测机制
说明每周/每阶段如何自测、如何判断是否需要调整计划，给出具体的检验题目形式或标准。

## 八、常见风险与应对
列出 2-4 个该学员最可能遇到的问题及具体对策。

## 九、给学员的一段话
3-5 句真诚、有力量的鼓励。
"""


def build_messages(profile: Dict[str, Any]) -> List[Dict[str, str]]:
    """把校验后的表单数据拼成对话消息。"""
    lines: List[str] = [
        "请根据下面这位学员的信息，定制一份学习计划。",
        "",
        "【学员基本信息】",
        f"- 姓名：{profile['name']}",
        f"- 性别：{profile['gender']}",
        f"- 年龄：{profile['age']} 岁",
        f"- 学历：{profile['education']}",
        "",
        "【知识基础】",
        profile["knowledge_base"],
        "",
        "【学习习惯】",
        profile["study_habit"],
    ]

    optional_lines = []
    if profile.get("goal"):
        optional_lines.append(f"- 学习目标：{profile['goal']}")
    if profile.get("weekly_hours"):
        optional_lines.append(f"- 每周可投入时间：{profile['weekly_hours']}")
    if profile.get("duration"):
        optional_lines.append(f"- 期望计划周期：{profile['duration']}")
    if profile.get("preference"):
        optional_lines.append(f"- 偏好的学习方式：{profile['preference']}")

    if optional_lines:
        lines += ["", "【补充信息】", *optional_lines]
    else:
        lines += [
            "",
            "【补充信息】",
            "- 学员未填写补充信息，请你根据已有信息合理推断学习目标与周期，并在计划中说明假设。",
        ]

    lines += [
        "",
        "现在请直接输出这份学习计划（Markdown 格式，不要客套，不要重复我的问题）。",
    ]

    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "\n".join(lines)},
    ]
